export const COLLATERAL_PROVIDER = 'COLLATERAL_PROVIDER';

export interface CollateralProvider {
  createPaymentRequest(params: {
    amount_sat: bigint;
    memo: string;
    expiry_seconds: number;
  }): Promise<{
    provider_reference: string;   // unique ID for dedup (e.g. Lightning payment hash)
    payment_request: string;      // BOLT11 invoice — what the customer scans/pastes
    receiving_address: string;    // identifier used as Redis cache key for webhook matching
    expires_at: Date;
  }>;

  // Creates a fresh BTC on-chain receiving address (used for onchain collateral — v2).
  createOnchainAddress(): Promise<string>;

  // Sends SAT to an external Lightning address (used for collateral release + liquidation surplus).
  // Returns a provider-level reference string for audit.
  sendToLightningAddress(params: {
    address: string;
    amount_sat: bigint;
    memo: string;
  }): Promise<string>;

  // Sends SAT to a BTC on-chain address (used for onchain collateral release — v2).
  // Returns a provider-level reference string for audit.
  sendToOnchainAddress(params: {
    address: string;
    amount_sat: bigint;
  }): Promise<string>;

  // Must be called on the RAW request body bytes before any JSON.parse().
  // For Blink: `signature` is JSON({ 'svix-id', 'svix-timestamp', 'svix-signature' }).
  verifyWebhookSignature(raw_body: string, signature: string): boolean;
}
