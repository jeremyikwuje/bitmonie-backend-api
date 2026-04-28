import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { PrismaService } from '@/database/prisma.service';
import type { DisbursementProvider, DisbursementBalance } from '@/modules/disbursements/disbursement.provider.interface';

@Injectable()
export class StubDisbursementProvider implements DisbursementProvider {
  constructor(private readonly prisma: PrismaService) {}

  async getBalance(): Promise<DisbursementBalance> {
    return { available_ngn: 10_000_000, frozen_ngn: 0, current_ngn: 10_000_000, unsettle_ngn: 0 };
  }

  // Returns the most recent verified tier-1 legal_name so name-match always passes
  // in local dev without needing a real PalmPay lookup.  Falls back to a fixed
  // stub name when no verified KYC exists (e.g. first boot).
  async lookupAccountName(_params: { bank_code: string; account_number: string }): Promise<string | null> {
    const verification = await this.prisma.kycVerification.findFirst({
      where: { tier: 1, status: 'VERIFIED' },
      orderBy: { verified_at: 'desc' },
      select: { legal_name: true },
    });
    return verification?.legal_name ?? 'Stub Test User';
  }

  async initiateTransfer(params: {
    amount: Decimal;
    currency: string;
    provider_name: string;
    provider_code: string;
    account_unique: string;
    account_name: string | null;
    reference: string;
    narration: string;
  }): Promise<{ provider_txn_id: string; provider_response: Record<string, unknown> }> {
    return {
      provider_txn_id: `stub_txn_${params.reference}`,
      provider_response: { source: 'stub', reference: params.reference },
    };
  }

  async getTransferStatus(_provider_reference: string): Promise<{
    status: 'processing' | 'successful' | 'failed';
  }> {
    return { status: 'successful' };
  }

  verifyWebhookSignature(_raw_body: string, _signature: string): boolean {
    return true;
  }
}
