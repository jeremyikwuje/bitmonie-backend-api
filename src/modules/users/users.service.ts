import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/database/prisma.service';

export interface UserProfile {
  id: string;
  email: string;
  email_verified: boolean;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  date_of_birth: Date | null;
  country: string;
  totp_enabled: boolean;
  // Boolean derivation of `transaction_pin_hash !== null`. Drives the
  // "Set transaction PIN" nudge in the Security panel without forcing the
  // web client to also call `/v1/auth/me`. The hash itself never leaves the
  // server.
  transaction_pin_set: boolean;
  kyc_tier: number;
  is_active: boolean;
  disbursement_enabled: boolean;
  loan_enabled: boolean;
  repayment_account: {
    virtual_account_no: string;
    virtual_account_name: string;
    bank_name: string;
    provider: string;
  } | null;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(user_id: string): Promise<UserProfile> {
    const row = await this.prisma.user.findUniqueOrThrow({
      where: { id: user_id },
      select: {
        id: true,
        email: true,
        email_verified: true,
        first_name: true,
        middle_name: true,
        last_name: true,
        date_of_birth: true,
        country: true,
        totp_enabled: true,
        transaction_pin_hash: true,
        kyc_tier: true,
        is_active: true,
        disbursement_enabled: true,
        loan_enabled: true,
        created_at: true,
        updated_at: true,
        repayment_account: {
          select: {
            virtual_account_no: true,
            virtual_account_name: true,
            bank_name: true,
            provider: true,
          },
        },
      },
    });
    const { transaction_pin_hash, ...rest } = row;
    return { ...rest, transaction_pin_set: transaction_pin_hash !== null };
  }
}
