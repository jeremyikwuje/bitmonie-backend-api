import { Injectable, NotFoundException } from '@nestjs/common';
import { DisbursementAccountKind, DisbursementAccountStatus, DisbursementRail } from '@prisma/client';
import { PrismaService } from '@/database/prisma.service';
import { NameMatchService } from '@/common/name-match/name-match.service';
import { DisbursementRouter } from '@/modules/disbursements/disbursement-router.service';
import {
  DisbursementAccountNameMismatchException,
  DisbursementAccountMaxPerKindException,
  DisbursementAccountDefaultDeleteException,
} from '@/common/errors/bitmonie.errors';
import { DISBURSEMENT_NAME_MATCH_THRESHOLD, MAX_DISBURSEMENT_ACCOUNTS_PER_KIND } from '@/common/constants';
import type { AddDisbursementAccountDto } from './dto/add-disbursement-account.dto';

const NAME_MATCHED_KINDS: DisbursementAccountKind[] = [
  DisbursementAccountKind.BANK,
  DisbursementAccountKind.MOBILE_MONEY,
];

const KIND_TO_RAIL: Record<DisbursementAccountKind, DisbursementRail | null> = {
  [DisbursementAccountKind.BANK]:            DisbursementRail.BANK_TRANSFER,
  [DisbursementAccountKind.MOBILE_MONEY]:    DisbursementRail.MOBILE_MONEY,
  [DisbursementAccountKind.CRYPTO_ADDRESS]:  null,
};

@Injectable()
export class DisbursementAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly name_match: NameMatchService,
    private readonly disbursement_router: DisbursementRouter,
  ) {}

  async addAccount(
    user_id: string,
    dto: AddDisbursementAccountDto,
  ): Promise<{ id: string; message: string }> {
    const existing_count = await this.prisma.disbursementAccount.count({
      where: { user_id, kind: dto.kind },
    });
    if (existing_count >= MAX_DISBURSEMENT_ACCOUNTS_PER_KIND) {
      throw new DisbursementAccountMaxPerKindException({
        kind: dto.kind,
        limit: MAX_DISBURSEMENT_ACCOUNTS_PER_KIND,
      });
    }

    let account_holder_name: string | null = null;
    let name_match_score: number | null = null;
    let status = DisbursementAccountStatus.VERIFIED;

    if (NAME_MATCHED_KINDS.includes(dto.kind)) {
      const user = await this.prisma.user.findUniqueOrThrow({ where: { id: user_id } });
      const rail = KIND_TO_RAIL[dto.kind]!;
      const provider = this.disbursement_router.forRoute('NGN', rail);
      const fetched_name = await provider.lookupAccountName({
        bank_code: dto.provider_code,
        account_number: dto.account_unique,
      });

      if (fetched_name) {
        const kyc_name = [user.first_name, user.middle_name, user.last_name]
          .filter(Boolean)
          .join(' ');
        const score = this.name_match.compare(kyc_name, fetched_name);

        if (score < DISBURSEMENT_NAME_MATCH_THRESHOLD) {
          throw new DisbursementAccountNameMismatchException({ score });
        }

        account_holder_name = fetched_name;
        name_match_score = score;
      }
    }

    const is_first = existing_count === 0;

    const account = await this.prisma.disbursementAccount.create({
      data: {
        user_id,
        kind: dto.kind,
        currency: 'NGN',
        provider_name: dto.provider_name,
        provider_code: dto.provider_code,
        account_unique: dto.account_unique,
        account_unique_tag: dto.account_unique_tag ?? null,
        label: dto.label ?? null,
        account_holder_name,
        name_match_score,
        is_default: is_first,
        status,
        verified_at: status === DisbursementAccountStatus.VERIFIED ? new Date() : null,
      },
    });

    return {
      id: account.id,
      message: 'Disbursement account added successfully.',
    };
  }

  async listAccounts(user_id: string): Promise<{
    accounts: Array<{
      id: string;
      kind: DisbursementAccountKind;
      provider_name: string;
      provider_code: string;
      account_unique: string;
      account_unique_tag: string | null;
      label: string | null;
      account_holder_name: string | null;
      is_default: boolean;
      status: DisbursementAccountStatus;
      created_at: Date;
    }>;
  }> {
    const accounts = await this.prisma.disbursementAccount.findMany({
      where: { user_id },
      select: {
        id: true,
        kind: true,
        provider_name: true,
        provider_code: true,
        account_unique: true,
        account_unique_tag: true,
        label: true,
        account_holder_name: true,
        is_default: true,
        status: true,
        created_at: true,
      },
      orderBy: [{ is_default: 'desc' }, { created_at: 'asc' }],
    });

    return { accounts };
  }

  async setDefault(user_id: string, account_id: string): Promise<{ message: string }> {
    const account = await this.prisma.disbursementAccount.findFirst({
      where: { id: account_id, user_id },
    });

    if (!account) throw new NotFoundException('Disbursement account not found.');

    await this.prisma.$transaction(async (tx) => {
      await tx.disbursementAccount.updateMany({
        where: { user_id, kind: account.kind, is_default: true },
        data: { is_default: false },
      });
      await tx.disbursementAccount.update({
        where: { id: account_id },
        data: { is_default: true },
      });
    });

    return { message: 'Default disbursement account updated.' };
  }

  async deleteAccount(user_id: string, account_id: string): Promise<{ message: string }> {
    const account = await this.prisma.disbursementAccount.findFirst({
      where: { id: account_id, user_id },
    });

    if (!account) throw new NotFoundException('Disbursement account not found.');

    if (account.is_default) {
      const same_kind_count = await this.prisma.disbursementAccount.count({
        where: { user_id, kind: account.kind },
      });
      if (same_kind_count === 1) throw new DisbursementAccountDefaultDeleteException();
    }

    await this.prisma.disbursementAccount.delete({ where: { id: account_id } });

    return { message: 'Disbursement account deleted.' };
  }
}
