import { Injectable, Inject, HttpStatus, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { KycIdType, KycStatus, type Prisma } from '@prisma/client';
import { PrismaService } from '@/database/prisma.service';
import { CryptoService } from '@/common/crypto/crypto.service';
import { NameMatchService } from '@/common/name-match/name-match.service';
import { UserRepaymentAccountsService } from '@/modules/user-repayment-accounts/user-repayment-accounts.service';
import { KYC_PROVIDER_T1, KYC_PROVIDER_T2, KYC_PROVIDER_T3, type KycProvider, type KycVerifyResult } from './kyc.provider.interface';
import type { SubmitKycDto } from './dto/submit-kyc.dto';
import type { RevokeKycDto } from './dto/revoke-kyc.dto';
import {
  BitmonieException,
  KycAlreadyVerifiedException,
  KycBiodataMismatchException,
  KycPendingException,
} from '@/common/errors/bitmonie.errors';
import { DISBURSEMENT_NAME_MATCH_THRESHOLD } from '@/common/constants';

const TIER_1 = 1;

function normalize_dob(raw: string): string | null {
  // Accept YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY → normalise to YYYY-MM-DD
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return raw;
  const dmy_dash  = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dmy_dash)  return `${dmy_dash[3]}-${dmy_dash[2]}-${dmy_dash[1]}`;
  const dmy_slash = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmy_slash) return `${dmy_slash[3]}-${dmy_slash[2]}-${dmy_slash[1]}`;
  return null;
}

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto_service: CryptoService,
    private readonly name_match: NameMatchService,
    private readonly user_repayment_accounts: UserRepaymentAccountsService,
    @Inject(KYC_PROVIDER_T1) private readonly kyc_provider_t1: KycProvider,
    @Inject(KYC_PROVIDER_T2) private readonly kyc_provider_t2: KycProvider,
    @Inject(KYC_PROVIDER_T3) private readonly kyc_provider_t3: KycProvider,
  ) {}

  private providerForTier(tier: number): KycProvider {
    switch (tier) {
      case 1:  return this.kyc_provider_t1;
      case 2:  return this.kyc_provider_t2;
      default: return this.kyc_provider_t3;
    }
  }

  async submitTier1(user_id: string, dto: SubmitKycDto): Promise<{ message: string }> {
    const existing = await this.prisma.kycVerification.findUnique({
      where: { user_id_tier: { user_id, tier: TIER_1 } },
    });

    if (existing?.status === KycStatus.VERIFIED) throw new KycAlreadyVerifiedException();
    if (existing?.status === KycStatus.UNDER_REVIEW) throw new KycPendingException();

    const salt = randomBytes(16).toString('hex');
    const id_number_hash = createHash('sha256').update(salt + dto.id_number).digest('hex');
    const encrypted_id_number = this.crypto_service.encrypt(dto.id_number);

    let legal_name: string;
    let provider_reference: string;
    let provider_raw_response: Record<string, unknown>;
    let verified_dob: Date | null = null;

    try {
      const result = await this.resolveIdNumber(TIER_1, dto);
      legal_name = result.legal_name;
      provider_reference = result.provider_reference;
      provider_raw_response = result.raw_response;
      this.verifyBiodata(dto, result.legal_name, result.date_of_birth);
      if (result.date_of_birth) {
        const normalised = normalize_dob(result.date_of_birth);
        if (normalised) verified_dob = new Date(normalised);
      }
    } catch (err) {
      if (err instanceof KycBiodataMismatchException) throw err;
      this.logger.error(
        { user_id, id_type: dto.id_type, error: err instanceof Error ? err.message : String(err) },
        'KYC tier-1 provider verification failed',
      );
      throw new BitmonieException(
        'KYC_PROVIDER_ERROR',
        'Identity verification could not be completed. Please check your details and try again.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.kycVerification.upsert({
        where: { user_id_tier: { user_id, tier: TIER_1 } },
        create: {
          user_id,
          tier: TIER_1,
          id_type: dto.id_type,
          id_number_hash,
          encrypted_id_number,
          legal_name,
          date_of_birth: verified_dob,
          provider_reference,
          provider_raw_response: provider_raw_response as object,
          status: KycStatus.VERIFIED,
          verified_at: new Date(),
        },
        update: {
          id_type: dto.id_type,
          id_number_hash,
          encrypted_id_number,
          legal_name,
          date_of_birth: verified_dob,
          provider_reference,
          provider_raw_response: provider_raw_response as object,
          status: KycStatus.VERIFIED,
          verified_at: new Date(),
          failure_reason: null,
        },
      });

      await tx.user.update({
        where: { id: user_id },
        data: {
          kyc_tier: TIER_1,
          first_name: dto.first_name,
          middle_name: dto.middle_name ?? null,
          last_name: dto.last_name,
          date_of_birth: verified_dob,
        },
      });
    });

    // Provision the customer's permanent NGN repayment VA. Wrapped — a provider
    // failure here must not fail the KYC verification itself; ops will retry.
    try {
      await this.user_repayment_accounts.ensureForUser(user_id);
    } catch (err) {
      this.logger.error(
        { user_id, error: err instanceof Error ? err.message : String(err) },
        'Post-KYC repayment VA provisioning failed — ops must retry',
      );
    }

    return { message: 'Identity verified successfully.' };
  }

  async getStatus(user_id: string): Promise<{
    kyc_tier: number;
    verifications: Array<{ tier: number; status: KycStatus; verified_at: Date | null }>;
  }> {
    const [user, verifications] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: user_id } }),
      this.prisma.kycVerification.findMany({
        where: { user_id },
        select: { tier: true, status: true, verified_at: true },
        orderBy: { tier: 'asc' },
      }),
    ]);

    return { kyc_tier: user.kyc_tier, verifications };
  }

  // Returns each tier verification plus the provider's raw payload —
  // useful for the customer (and ops, when impersonating) to inspect what
  // the upstream KYC vendor (EaseID / Dojah / QoreID) actually returned.
  // Encrypted/hashed columns are deliberately omitted; raw_response already
  // strips photo blobs at the provider layer.
  async listVerifications(user_id: string): Promise<Array<{
    tier: number;
    id_type: KycIdType | null;
    status: KycStatus;
    legal_name: string | null;
    date_of_birth: Date | null;
    provider_reference: string | null;
    provider_raw_response: Prisma.JsonValue | null;
    failure_reason: string | null;
    verified_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }>> {
    return this.prisma.kycVerification.findMany({
      where: { user_id },
      select: {
        tier: true,
        id_type: true,
        status: true,
        legal_name: true,
        date_of_birth: true,
        provider_reference: true,
        provider_raw_response: true,
        failure_reason: true,
        verified_at: true,
        created_at: true,
        updated_at: true,
      },
      orderBy: { tier: 'asc' },
    });
  }

  // Optional `on_in_tx` runs inside the same Prisma transaction that deletes
  // the verifications and bumps the user's kyc_tier — load-bearing for ops
  // callers that must write an OpsAuditLog row atomically with the action
  // (mirror of loan_status_logs discipline, CLAUDE.md §5.4). If the callback
  // throws, the whole revoke rolls back and no audit row exists. Customer
  // callers pass nothing and behave exactly as before.
  async revokeToTier(
    user_id: string,
    dto: RevokeKycDto,
    on_in_tx?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<{ message: string }> {
    await this.prisma.$transaction(async (tx) => {
      await tx.kycVerification.deleteMany({
        where: { user_id, tier: { gt: dto.target_tier } },
      });
      await tx.user.update({
        where: { id: user_id },
        data: { kyc_tier: dto.target_tier },
      });
      if (on_in_tx) await on_in_tx(tx);
    });

    const label = dto.target_tier === 0 ? 'reset to unverified' : `revoked to tier ${dto.target_tier}`;
    return { message: `KYC ${label}.` };
  }

  private verifyBiodata(
    dto: SubmitKycDto,
    official_name: string,
    official_dob: string | undefined,
  ): void {
    const submitted_name = [dto.first_name, dto.middle_name, dto.last_name]
      .filter(Boolean)
      .join(' ');
    const score = this.name_match.compare(submitted_name, official_name);
    if (score < DISBURSEMENT_NAME_MATCH_THRESHOLD) throw new KycBiodataMismatchException();

    if (official_dob) {
      const normalised = normalize_dob(official_dob);
      if (normalised && normalised !== dto.date_of_birth) throw new KycBiodataMismatchException();
    }
  }

  private async resolveIdNumber(
    tier: number,
    dto: SubmitKycDto,
  ): Promise<KycVerifyResult> {
    const provider = this.providerForTier(tier);
    const params = {
      id_number: dto.id_number,
      first_name: dto.first_name,
      last_name: dto.last_name,
      middle_name: dto.middle_name,
      date_of_birth: dto.date_of_birth,
    };
    switch (dto.id_type) {
      case KycIdType.BVN:             return provider.verifyBvn(params);
      case KycIdType.NIN:             return provider.verifyNin(params);
      case KycIdType.PASSPORT:        return provider.verifyPassport(params);
      case KycIdType.DRIVERS_LICENSE: return provider.verifyDriversLicense(params);
      default:
        throw new Error(`Unhandled id_type: ${dto.id_type as string}`);
    }
  }
}
