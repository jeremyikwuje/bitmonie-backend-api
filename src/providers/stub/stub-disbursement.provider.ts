import { Decimal } from 'decimal.js';
import type { DisbursementProvider, DisbursementBalance } from '@/modules/disbursements/disbursement.provider.interface';

export class StubDisbursementProvider implements DisbursementProvider {
  async getBalance(): Promise<DisbursementBalance> {
    return { available_ngn: 10_000_000, frozen_ngn: 0, current_ngn: 10_000_000, unsettle_ngn: 0 };
  }

  async lookupAccountName(_params: { bank_code: string; account_number: string }): Promise<string | null> {
    // Returns the same name the StubKycProvider uses so name-match always passes in local dev.
    return 'Stub Test User';
  }

  async initiateTransfer(params: {
    amount: Decimal;
    currency: string;
    provider_name: string;
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
