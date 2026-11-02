import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KycIdType, type Prisma } from '@prisma/client';
import { PrismaService } from '@/database/prisma.service';
import { CryptoService } from '@/common/crypto/crypto.service';
import type {
  CollectionIdentityType,
  CollectionProvider,
} from '@/modules/loans/collection.provider.interface';
import type { ProvidersConfig } from '@/config/providers.config';

function mapToCollectionIdentityType(id_type: KycIdType): CollectionIdentityType | null {
  switch (id_type) {
    case KycIdType.BVN: return 'BVN';
    case KycIdType.NIN: return 'NIN';
    default: return null;
  }
}

export interface UserRepaymentAccountSummary {
  virtual_account_no:   string;
  virtual_account_name: string;
  bank_name:            string;
  provider:             string;
}

export interface EnsureForUserResult {
  summary: UserRepaymentAccountSummary;
  // True iff a new VA row was just created in this call. Lets ops callers
  // decide whether to audit (only newly-created VAs warrant an audit row —
  // an idempotent retry that hits an existing VA is read-only).
  created: boolean;
}

export interface ReplaceForUserResult {
  summary: UserRepaymentAccountSummary;
  // The VA this one replaced, now inactive. Null when the user had none.
  retired: UserRepaymentAccountSummary | null;
}

type RepaymentAccountRow = {
  virtual_account_no:   string;
  virtual_account_name: string;
  bank_name:            string;
  provider:             string;
};

function toSummary(row: RepaymentAccountRow): UserRepaymentAccountSummary {
  return {
    virtual_account_no:   row.virtual_account_no,
    virtual_account_name: row.virtual_account_name,
    bank_name:            row.bank_name,
    provider:             row.provider,
  };
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

  // Idempotent: returns the user's active VA, or provisions one via the
  // collection provider on first call. Triggered after tier-1 KYC verification
  // succeeds (see KycService.submitTier1) so every customer ready for a loan
  // already has a permanent NGN VA tied to their tier-1 identity (BVN or NIN).
  //
  // Returns null when tier-1 KYC is missing, incomplete, or backed by a
  // document type the collection rail can't anchor a VA to (passport /
  // drivers-license). The caller is expected to log + retry later, never
  // to fail the parent flow. Throws only on provider errors that the
  // caller should propagate.
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
    const existing = await this.findActive(user_id);
    if (existing) return { summary: toSummary(existing), created: false };

    const provisioned = await this._provision(user_id, user_id);
    if (!provisioned) return null;
    const { result, provider_name } = provisioned;

    const account = await this.prisma.$transaction(async (tx) => {
      const created = await tx.userRepaymentAccount.create({
        data: {
          user_id,
          virtual_account_no:   result.virtual_account_no,
          virtual_account_name: result.virtual_account_name,
          bank_name:            result.bank_name,
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

    return { summary: toSummary(account), created: true };
  }

  // Issues the user a new VA and retires the active one, in that order: the
  // old VA stays active until the provider has issued the new one, so a
  // failure (null, or a thrown provider error) leaves the customer with a
  // working account. The retired row is kept, inactive — the collection
  // webhook routes by VA number, so a transfer into it still credits them.
  async replaceForUser(user_id: string): Promise<ReplaceForUserResult | null> {
    const current = await this.findActive(user_id);

    // The first VA was issued with account_reference = user_id; each
    // replacement gets its own, as PalmPay may hold that reference to one VA.
    const provisioned = await this._provision(user_id, `${user_id}-${Date.now()}`);
    if (!provisioned) return null;
    const { result, provider_name } = provisioned;

    const account = await this.prisma.$transaction(async (tx) => {
      await tx.userRepaymentAccount.updateMany({
        where: { user_id, is_active: true },
        data:  { is_active: false, deactivated_at: new Date() },
      });
      return tx.userRepaymentAccount.create({
        data: {
          user_id,
          virtual_account_no:   result.virtual_account_no,
          virtual_account_name: result.virtual_account_name,
          bank_name:            result.bank_name,
          provider:             provider_name,
        },
      });
    });

    this.logger.log(
      {
        user_id,
        provider:           provider_name,
        virtual_account_no: account.virtual_account_no,
        retired:            current?.virtual_account_no ?? null,
      },
      'User repayment VA replaced',
    );

    return { summary: toSummary(account), retired: current ? toSummary(current) : null };
  }

  findActive(user_id: string) {
    return this.prisma.userRepaymentAccount.findFirst({
      where: { user_id, is_active: true },
    });
  }

  // Opens a VA at the collection provider against the user's tier-1 identity.
  // Null when tier-1 KYC can't back one (see ensureForUser).
  private async _provision(user_id: string, account_reference: string) {
    const verification = await this.prisma.kycVerification.findUnique({
      where: { user_id_tier: { user_id, tier: 1 } },
      select: {
        encrypted_id_number: true,
        legal_name:          true,
        id_type:             true,
        user: { select: { first_name: true, last_name: true } },
      },
    });
    if (
      !verification?.encrypted_id_number ||
      !verification.legal_name ||
      !verification.id_type ||
      !verification.user.first_name ||
      !verification.user.last_name
    ) {
      this.logger.warn({ user_id }, 'ensureForUser: tier-1 KYC missing or incomplete — skipping');
      return null;
    }

    // Only BVN/NIN tier-1 verifications can back a Nigerian VA — passport
    // / drivers-license entries (if/when added at tier-1) are rejected by
    // the collection rail.
    const identity_type = mapToCollectionIdentityType(verification.id_type);
    if (!identity_type) {
      this.logger.warn(
        { user_id, id_type: verification.id_type },
        'ensureForUser: tier-1 id_type does not support VA provisioning — skipping',
      );
      return null;
    }

    const license_number = this.crypto_service.decrypt(verification.encrypted_id_number);
    const provider_name = this.config.get<ProvidersConfig>('providers')!.active.collection;
    // Inbound senders see virtualAccountName on their bank statement, so the
    // customer's own first + last name is what makes the VA recognisable as
    // theirs. legal_name (provider-returned, may include middle name and may
    // differ in casing/order) is still passed through as customerName for
    // PalmPay's BVN/NIN cross-check.
    const virtual_account_name = `${verification.user.first_name} ${verification.user.last_name}`;

    const result = await this.collection.createVirtualAccount({
      virtual_account_name,
      identity_type,
      license_number,
      customer_name:        verification.legal_name,
      account_reference,
    });

    return { result, provider_name };
  }
}
