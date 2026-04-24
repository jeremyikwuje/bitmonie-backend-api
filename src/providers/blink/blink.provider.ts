import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import Decimal from 'decimal.js';
import type { BlinkConfig } from '@/config/providers.config';
import type { CollateralProvider } from '@/modules/payment-requests/collateral.provider.interface';
import type { PriceQuoteProvider } from '@/modules/loans/price-quote.provider.interface';
import { SATS_PER_BTC } from '@/common/constants';
import { CollateralInvoiceFailedException } from '@/common/errors/bitmonie.errors';
import {
  BlinkLnInvoiceCreateResponseSchema,
  BlinkLnNoAmountInvoiceCreateResponseSchema,
  BlinkLnAddressPaymentSendResponseSchema,
  BlinkOnchainAddressCreateResponseSchema,
  BlinkOnchainPaymentSendResponseSchema,
  BlinkIntraLedgerPaymentSendResponseSchema,
  BlinkRealtimePriceResponseSchema,
  type BlinkWebhookHeaders,
} from './blink.types';

// Svix replay-attack window: reject timestamps older than 5 minutes.
const SVIX_TOLERANCE_SECONDS = 300;

@Injectable()
export class BlinkProvider implements CollateralProvider, PriceQuoteProvider {
  private readonly logger = new Logger(BlinkProvider.name);

  constructor(private readonly config: BlinkConfig) {}

  // ── GraphQL transport ──────────────────────────────────────────────────────

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    schema: { parse: (v: unknown) => T },
  ): Promise<T> {
    const response = await fetch(`${this.config.base_url}/graphql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-API-KEY': this.config.api_key,
      },
      body: JSON.stringify({ query, variables }),
    });

    const json: unknown = await response.json();
    return schema.parse(json);
  }

  // ── createPaymentRequest ───────────────────────────────────────────────────

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
    // Blink expiresIn is in minutes — round up to ensure we don't expire early.
    const expiry_minutes = Math.ceil(params.expiry_seconds / 60);

    const mutation = `
      mutation LnInvoiceCreate($input: LnInvoiceCreateInput!) {
        lnInvoiceCreate(input: $input) {
          invoice {
            paymentRequest
            paymentHash
            satoshis
          }
          errors {
            message
          }
        }
      }
    `;

    const data = await this.graphql(
      mutation,
      {
        input: {
          walletId: this.config.wallet_btc_id,
          amount: Number(params.amount_sat),
          memo: params.memo,
          expiresIn: expiry_minutes,
        },
      },
      BlinkLnInvoiceCreateResponseSchema,
    );

    const result = data.data.lnInvoiceCreate;

    if (result.errors.length > 0 || !result.invoice) {
      this.logger.error('lnInvoiceCreate failed', { errors: result.errors });
      throw new CollateralInvoiceFailedException();
    }

    const expires_at = new Date(Date.now() + params.expiry_seconds * 1000);

    return {
      // paymentHash is the stable dedup key — it's what Blink sends in the webhook.
      provider_reference: result.invoice.paymentHash,
      payment_request: result.invoice.paymentRequest,
      receiving_address: result.invoice.paymentHash,
      expires_at,
    };
  }

  // ── createNoAmountInvoice ─────────────────────────────────────────────────
  // Variable-amount Lightning invoice. Used for collateral top-ups on ACTIVE loans.

  async createNoAmountInvoice(params: {
    memo: string;
    expiry_seconds: number;
  }): Promise<{
    provider_reference: string;
    payment_request: string;
    receiving_address: string;
    expires_at: Date;
  }> {
    const expiry_minutes = Math.ceil(params.expiry_seconds / 60);

    const mutation = `
      mutation LnNoAmountInvoiceCreate($input: LnNoAmountInvoiceCreateInput!) {
        lnNoAmountInvoiceCreate(input: $input) {
          invoice {
            paymentRequest
            paymentHash
          }
          errors {
            message
          }
        }
      }
    `;

    const data = await this.graphql(
      mutation,
      {
        input: {
          walletId:  this.config.wallet_btc_id,
          memo:      params.memo,
          expiresIn: expiry_minutes,
        },
      },
      BlinkLnNoAmountInvoiceCreateResponseSchema,
    );

    const result = data.data.lnNoAmountInvoiceCreate;

    if (result.errors.length > 0 || !result.invoice) {
      this.logger.error('lnNoAmountInvoiceCreate failed', { errors: result.errors });
      throw new CollateralInvoiceFailedException();
    }

    return {
      provider_reference: result.invoice.paymentHash,
      payment_request:    result.invoice.paymentRequest,
      receiving_address:  result.invoice.paymentHash,
      expires_at:         new Date(Date.now() + params.expiry_seconds * 1000),
    };
  }

  // ── createOnchainAddress ──────────────────────────────────────────────────

  async createOnchainAddress(): Promise<string> {
    const mutation = `
      mutation OnChainAddressCreate($input: OnChainAddressCreateInput!) {
        onChainAddressCreate(input: $input) {
          address
          errors {
            message
          }
        }
      }
    `;

    const data = await this.graphql(
      mutation,
      { input: { walletId: this.config.wallet_btc_id } },
      BlinkOnchainAddressCreateResponseSchema,
    );

    const result = data.data.onChainAddressCreate;

    if (result.errors.length > 0 || !result.address) {
      this.logger.error('onChainAddressCreate failed', { errors: result.errors });
      throw new Error(`Blink onChainAddressCreate failed: ${result.errors.map((e) => e.message).join(', ')}`);
    }

    return result.address;
  }

  // ── sendToLightningAddress ─────────────────────────────────────────────────

  async sendToLightningAddress(params: {
    address: string;
    amount_sat: bigint;
    memo: string;
  }): Promise<string> {
    const mutation = `
      mutation LnAddressPaymentSend($input: LnAddressPaymentSendInput!) {
        lnAddressPaymentSend(input: $input) {
          status
          errors {
            code
            message
          }
        }
      }
    `;

    const data = await this.graphql(
      mutation,
      {
        input: {
          walletId: this.config.wallet_btc_id,
          lnAddress: params.address,
          amount: Number(params.amount_sat),
        },
      },
      BlinkLnAddressPaymentSendResponseSchema,
    );

    const result = data.data.lnAddressPaymentSend;

    if (result.status === 'FAILURE' || result.errors.length > 0) {
      const reason = result.errors.map((e) => e.message).join(', ') || 'FAILURE';
      this.logger.error('lnAddressPaymentSend failed', { result });
      throw new Error(`Blink sendToLightningAddress failed: ${reason}`);
    }

    // Blink does not return a payment hash for lnAddressPaymentSend.
    // Encode the intent as a stable audit reference.
    return `blink:ln_address:${params.address}:${params.amount_sat}:${Date.now()}`;
  }

  // ── sendToOnchainAddress ───────────────────────────────────────────────────

  async sendToOnchainAddress(params: {
    address: string;
    amount_sat: bigint;
  }): Promise<string> {
    const mutation = `
      mutation OnChainPaymentSend($input: OnChainPaymentSendInput!) {
        onChainPaymentSend(input: $input) {
          status
          errors {
            message
          }
        }
      }
    `;

    const data = await this.graphql(
      mutation,
      {
        input: {
          walletId: this.config.wallet_btc_id,
          address: params.address,
          amount: Number(params.amount_sat),
        },
      },
      BlinkOnchainPaymentSendResponseSchema,
    );

    const result = data.data.onChainPaymentSend;

    if (result.status === 'FAILURE' || result.errors.length > 0) {
      const reason = result.errors.map((e) => e.message).join(', ') || 'FAILURE';
      this.logger.error('onChainPaymentSend failed', { result });
      throw new Error(`Blink sendToOnchainAddress failed: ${reason}`);
    }

    return `blink:onchain:${params.address}:${params.amount_sat}:${Date.now()}`;
  }

  // ── getBtcUsdRate ─────────────────────────────────────────────────────────
  // Used at loan origination to pin `initial_collateral_usd` on the Loan row.
  // Blink's realtimePrice with currency='USD' returns btcSatPrice in USDCENT
  // per sat (scaled-integer encoding):  usdcent_per_sat = base / 10^offset
  // → usd_per_btc = usdcent_per_sat / 100 × SATS_PER_BTC.

  async getBtcUsdRate(): Promise<Decimal> {
    const query = `
      query RealtimePrice($currency: DisplayCurrency!) {
        realtimePrice(currency: $currency) {
          btcSatPrice {
            base
            offset
            currencyUnit
          }
        }
      }
    `;

    const data = await this.graphql(
      query,
      { currency: 'USD' },
      BlinkRealtimePriceResponseSchema,
    );

    const { base, offset, currencyUnit } = data.data.realtimePrice.btcSatPrice;

    console.log(data.data)

    if (currencyUnit !== 'MINOR') {
      throw new Error(`Blink getBtcUsdRate: unexpected currencyUnit ${currencyUnit} (expected USDCENT)`);
    }

    const usdcent_per_sat = new Decimal(base).div(new Decimal(10).pow(offset));
    return usdcent_per_sat.div(100).mul(SATS_PER_BTC);
  }

  // ── isOwnAccount ──────────────────────────────────────────────────────────
  // Returns true when the accountId in a webhook payload matches our configured account.

  isOwnAccount(account_id: string): boolean {
    return account_id === this.config.account_id;
  }

  // ── swapBtcToUsd ───────────────────────────────────────────────────────────
  // Moves sats from the BTC wallet to the USD stable-sats wallet via Blink
  // intraledger transfer.  Called after loan liquidation to convert seized
  // collateral into a stable denomination.

  async swapBtcToUsd(amount_sat: bigint): Promise<void> {
    const mutation = `
      mutation IntraLedgerPaymentSend($input: IntraLedgerPaymentSendInput!) {
        intraLedgerPaymentSend(input: $input) {
          status
          errors {
            message
            code
          }
        }
      }
    `;

    const data = await this.graphql(
      mutation,
      {
        input: {
          walletId:            this.config.wallet_btc_id,
          recipientWalletId:   this.config.wallet_usd_id,
          amount:              Number(amount_sat),
        },
      },
      BlinkIntraLedgerPaymentSendResponseSchema,
    );

    const result = data.data.intraLedgerPaymentSend;

    if (result.status === 'FAILURE' || result.errors.length > 0) {
      const reason = result.errors.map((e) => e.message).join(', ') || 'FAILURE';
      this.logger.error('intraLedgerPaymentSend failed', { result });
      throw new Error(`Blink swapBtcToUsd failed: ${reason}`);
    }
  }

  // ── verifyWebhookSignature ─────────────────────────────────────────────────
  // Blink uses Svix for webhook delivery.
  // Signed content:  `${svix-id}.${svix-timestamp}.${raw_body}`
  // Secret:          base64-decode the portion after 'whsec_' prefix
  // Signature header: space-delimited list of "v1,<base64>" entries

  verifyWebhookSignature(raw_body: string, signature: string): boolean {
    try {
      const headers = JSON.parse(signature) as Partial<BlinkWebhookHeaders>;

      const msg_id = headers['svix-id'];
      const msg_timestamp = headers['svix-timestamp'];
      const msg_signatures = headers['svix-signature'];

      if (!msg_id || !msg_timestamp || !msg_signatures) return false;

      // Reject stale timestamps to prevent replay attacks.
      const ts = parseInt(msg_timestamp, 10);
      if (Number.isNaN(ts)) return false;
      const age_seconds = Math.abs(Math.floor(Date.now() / 1000) - ts);
      if (age_seconds > SVIX_TOLERANCE_SECONDS) return false;

      const signed_content = `${msg_id}.${msg_timestamp}.${raw_body}`;

      const secret_base64 = this.config.webhook_secret.replace(/^whsec_/, '');
      const secret_bytes = Buffer.from(secret_base64, 'base64');

      const expected = crypto
        .createHmac('sha256', secret_bytes)
        .update(signed_content)
        .digest('base64');

      const expected_buf = Buffer.from(expected);

      // Header may carry multiple space-delimited signatures (Svix key rotation).
      return msg_signatures.split(' ').some((sig) => {
        const sig_value = sig.replace(/^v1,/, '');
        try {
          return crypto.timingSafeEqual(expected_buf, Buffer.from(sig_value));
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  }
}
