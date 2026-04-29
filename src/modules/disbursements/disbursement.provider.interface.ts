import type { Decimal } from 'decimal.js';

export const DISBURSEMENT_PROVIDER = 'DISBURSEMENT_PROVIDER';

export interface DisbursementBalance {
  available_ngn: number;
  frozen_ngn: number;
  current_ngn: number;
  unsettle_ngn: number;
}

export interface Bank {
  code: string;            // provider-specific code passed back as provider_code on payout
  name: string;            // human-readable label for the customer / narration
  logo_url: string | null; // brand mark URL — for the frontend bank-select dropdown
}

export interface DisbursementProvider {
  getBalance(): Promise<DisbursementBalance>;

  // Returns the list of banks (and bank-equivalent destinations) the provider
  // can route money to. Used by the public /banks endpoint to populate the
  // bank-select dropdown on the disbursement-account add screen.
  listBanks(): Promise<Bank[]>;

  lookupAccountName(params: {
    bank_code: string;
    account_number: string;
  }): Promise<string | null>;

  initiateTransfer(params: {
    amount: Decimal;
    currency: string;
    provider_name: string;    // human-readable label ("GTBank", "MTN Nigeria") — for narration / audit only
    provider_code: string;    // machine identifier expected by the provider ("058", "MTN") — used as payeeBankCode etc.
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
