import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '@/database/prisma.service';
import { CryptoService } from '@/common/crypto/crypto.service';
import type { CollectionProvider } from '@/modules/loans/collection.provider.interface';
import type { ProvidersConfig } from '@/config/providers.config';

export interface UserRepaymentAccountSummary {
  virtual_account_no:   string;
  virtual_account_name: string;
  provider:             string;
}

export interface EnsureForUserResult {
  summary: UserRepaymentAccountSummary;
  // True iff a new VA row was just created in this call. Lets ops callers
  // decide whether to audit (only newly-created VAs warrant an audit row —
  // an idempotent retry that hits an existing VA is read-only).
  created: boolean;
}

@Injectable()
export class UserRepaymentAccountsService {
  private readonly logger = new Logger(UserRepaymentAccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto_service: CryptoService,
    private readonly config: ConfigService,
    @Inject('COLLECTION_PROVIDER')
    private readonly collection: CollectionProvider,
  ) {}

  // Idempotent: returns the existing VA for the user, or provisions one via the
  // collection provider on first call. Triggered after tier-1 KYC verification
  // succeeds (see KycService.submitTier1) so every customer ready for a loan
  // already has a permanent NGN VA tied to their BVN.
  //
  // Returns null when tier-1 KYC is missing or has no decryptable BVN — the
  // caller is expected to log + retry later, never to fail the parent flow.
  // Throws only on provider errors that the caller should propagate.
  //
  // Optional `on_created_in_tx` runs inside the same Prisma transaction that
  // creates the VA row — fires only on the new-VA branch, never on the
  // already-exists branch. Lets ops callers atomically write an OpsAuditLog
  // row alongside the provisioning (mirror of loan_status_logs discipline,
  // CLAUDE.md §5.4). If the callback throws, the VA row is rolled back too.
  async ensureForUser(
    user_id: string,
    on_created_in_tx?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<EnsureForUserResult | null> {
    const existing = await this.prisma.userRepaymentAccount.findUnique({
      where: { user_id },
    });
    if (existing) {
      return {
        summary: {
          virtual_account_no:   existing.virtual_account_no,
          virtual_account_name: existing.virtual_account_name,
          provider:             existing.provider,
        },
        created: false,
      };
    }

    const verification = await this.prisma.kycVerification.findUnique({
      where: { user_id_tier: { user_id, tier: 1 } },
      select: { encrypted_id_number: true, legal_name: true },
    });
    if (!verification?.encrypted_id_number || !verification.legal_name) {
      this.logger.warn({ user_id }, 'ensureForUser: tier-1 KYC missing or incomplete — skipping');
      return null;
    }

    const bvn = this.crypto_service.decrypt(verification.encrypted_id_number);
    const provider_name = this.config.get<ProvidersConfig>('providers')!.active.collection;

    const result = await this.collection.createVirtualAccount({
      virtual_account_name: 'Bitmonie Loan Repayment',
      identity_type:        'BVN',
      license_number:       bvn,
      customer_name:        verification.legal_name,
      account_reference:    user_id,
    });

    const account = await this.prisma.$transaction(async (tx) => {
      const created = await tx.userRepaymentAccount.create({
        data: {
          user_id,
          virtual_account_no:   result.virtual_account_no,
          virtual_account_name: result.virtual_account_name,
          provider:             provider_name,
        },
      });
      if (on_created_in_tx) await on_created_in_tx(tx);
      return created;
    });

    this.logger.log(
      { user_id, provider: provider_name, virtual_account_no: account.virtual_account_no },
      'User repayment VA provisioned',
    );

    return {
      summary: {
        virtual_account_no:   account.virtual_account_no,
        virtual_account_name: account.virtual_account_name,
        provider:             account.provider,
      },
      created: true,
    };
  }
}
