import type { Decimal } from 'decimal.js';

export const DISBURSEMENT_PROVIDER = 'DISBURSEMENT_PROVIDER';

export interface DisbursementBalance {
  available_ngn: number;
  frozen_ngn: number;
  current_ngn: number;
  unsettle_ngn: number;
}

export interface DisbursementProvider {
  getBalance(): Promise<DisbursementBalance>;

  lookupAccountName(params: {
    bank_code: string;
    account_number: string;
  }): Promise<string | null>;

  initiateTransfer(params: {
    amount: Decimal;
    currency: string;
    provider_name: string;    // bank code or provider code
    account_unique: string;   // account number / phone / address
    account_name: string | null;
    reference: string;
    narration: string;
  }): Promise<{ provider_txn_id: string; provider_response: Record<string, unknown> }>;

  getTransferStatus(provider_reference: string): Promise<{
    status: 'processing' | 'successful' | 'failed';
    failure_reason?: string;
    failure_code?: string;
  }>;

  verifyWebhookSignature(raw_body: string, signature: string): boolean;
}
