import type { CollateralProvider } from '@/modules/payment-requests/collateral.provider.interface';

export class StubCollateralProvider implements CollateralProvider {
  async createPaymentRequest(params: {
    amount_sat: bigint;
    memo: string;
    expiry_seconds: number;
  }): Promise<{
    provider_reference: string;
    payment_request: string;
    receiving_address: string;
    expires_at: Date;
  }> {
    const payment_hash = `stub_hash_${params.amount_sat}_${Date.now()}`;
    return {
      provider_reference: payment_hash,
      payment_request: `lnbcrt${params.amount_sat}stub_invoice_${Date.now()}`,
      receiving_address: payment_hash,
      expires_at: new Date(Date.now() + params.expiry_seconds * 1000),
    };
  }

  async createNoAmountInvoice(params: {
    memo: string;
    expiry_seconds: number;
  }): Promise<{
    provider_reference: string;
    payment_request: string;
    receiving_address: string;
    expires_at: Date;
  }> {
    const payment_hash = `stub_topup_hash_${Date.now()}`;
    return {
      provider_reference: payment_hash,
      payment_request: `lnbcrt_noamount_${Date.now()}_${params.memo.slice(0, 8)}`,
      receiving_address: payment_hash,
      expires_at: new Date(Date.now() + params.expiry_seconds * 1000),
    };
  }

  async createOnchainAddress(): Promise<string> {
    return `stub_btc_address_${Date.now()}`;
  }

  async sendToLightningAddress(params: {
    address: string;
    amount_sat: bigint;
    memo: string;
  }): Promise<string> {
    return `stub:ln_address:${params.address}:${params.amount_sat}`;
  }

  async sendToOnchainAddress(params: {
    address: string;
    amount_sat: bigint;
  }): Promise<string> {
    return `stub:onchain:${params.address}:${params.amount_sat}`;
  }

  verifyWebhookSignature(_raw_body: string, _signature: string): boolean {
    return true;
  }
}
