import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as forge from 'node-forge';
import { Decimal } from 'decimal.js';
import type { PalmpayConfig } from '@/config/providers.config';
import type { DisbursementProvider } from '@/modules/disbursements/disbursement.provider.interface';
import {
  PalmpayQueryBankAccountResponseSchema,
  PalmpayPayoutResponseSchema,
  PalmpayQueryPayStatusResponseSchema,
  PalmpayQueryBalanceResponseSchema,
  PalmpayCreateVirtualAccountResponseSchema,
  PALMPAY_RESP_CODE_SUCCESS,
  PALMPAY_ORDER_STATUS_SUCCESS,
  PALMPAY_ORDER_STATUS_FAILED,
} from './palmpay.types';

function nonce_str(): string {
  return crypto.randomBytes(16).toString('hex');
}

@Injectable()
export class PalmpayProvider implements DisbursementProvider {
  private readonly logger = new Logger(PalmpayProvider.name);

  constructor(private readonly config: PalmpayConfig) {}

  // ── Signing ────────────────────────────────────────────────────────────────

  // PalmPay signing protocol:
  //   1. Sort all params (excluding nulls/empty), concat as key=value&…
  //   2. MD5-hash the result (uppercase hex)
  //   3. RSA-SHA1 sign the MD5 string using the merchant private key
  //   4. Base64-encode the signature → goes in the `Signature` request header
  private build_signature(params: Record<string, unknown>): string {
    const sorted = Object.keys(params)
      .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
      .sort()
      .map((k) => `${k}=${String(params[k])}`)
      .join('&');

    const md5 = crypto.createHash('md5').update(sorted, 'utf8').digest('hex').toUpperCase();

    const private_key = forge.pki.privateKeyFromPem(this.config.private_key);
    const md = forge.md.sha1.create();
    md.update(md5, 'utf8');
    const signature = private_key.sign(md);
    return Buffer.from(signature, 'binary').toString('base64');
  }

  private verify_webhook_sign(params: Record<string, unknown>, signature: string): boolean {
    try {
      const { sign: _, ...rest } = params;
      const sorted = Object.keys(rest)
        .sort()
        .map((k) => `${k}=${String(rest[k])}`)
        .join('&');
      const md5 = crypto.createHash('md5').update(sorted).digest('hex').toUpperCase();

      const public_key = forge.pki.publicKeyFromPem(this.config.webhook_pub_key);
      const md = forge.md.sha1.create();
      md.update(md5, 'utf8');
      // sign in webhook payload is URL-encoded base64
      const raw_sig = forge.util.decode64(decodeURIComponent(signature));
      return public_key.verify(md.digest().bytes(), raw_sig);
    } catch {
      return false;
    }
  }

  // ── HTTP ───────────────────────────────────────────────────────────────────

  private async post<T>(
    path: string,
    body: Record<string, unknown>,
    schema: { parse: (v: unknown) => T },
  ): Promise<T> {
    const payload: Record<string, unknown> = {
      ...body,
      requestTime: Date.now(),
      version: 'V1.1',
      nonceStr: nonce_str(),
    };

    const signature = this.build_signature(payload);

    const response = await fetch(`${this.config.base_url}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'CountryCode': 'NG',
        'Authorization': `Bearer ${this.config.app_id}`,
        'Signature': signature,
      },
      body: JSON.stringify(payload),
    });

    // Read body as text first so non-JSON error pages (HTML 500s, gateway
    // timeouts) are still visible in logs instead of throwing an opaque
    // SyntaxError on `response.json()`.
    const raw_text = await response.text();

    if (!response.ok) {
      this.logger.warn(
        { path, http_status: response.status, body: raw_text.slice(0, 1000) },
        'PalmPay non-OK HTTP response',
      );
      throw new Error(`PalmPay ${path} returned HTTP ${response.status}: ${raw_text.slice(0, 200)}`);
    }

    let json: unknown;
    try {
      json = JSON.parse(raw_text);
    } catch {
      this.logger.warn(
        { path, body: raw_text.slice(0, 1000) },
        'PalmPay response is not valid JSON',
      );
      throw new Error(`PalmPay ${path} returned non-JSON response`);
    }

    let parsed: T;
    try {
      parsed = schema.parse(json);
    } catch (err) {
      const safe = (json ?? {}) as { respCode?: unknown; respMsg?: unknown };
      this.logger.warn(
        { path, respCode: safe.respCode, respMsg: safe.respMsg, raw: json },
        'PalmPay response failed schema validation — see `raw` for the actual payload',
      );
      throw err;
    }

    // Surface every non-success respCode so ops can read the PalmPay reason
    // directly from logs (e.g. "Insufficient balance", "Account inactive").
    // PalmPay response bodies don't echo customer account numbers — only
    // orderId/orderNo/orderStatus/respMsg — so logging the full data object
    // is safe under §5.8.
    const result = parsed as { respCode?: string; respMsg?: string; data?: unknown };
    if (result.respCode !== PALMPAY_RESP_CODE_SUCCESS) {
      this.logger.warn(
        { path, respCode: result.respCode, respMsg: result.respMsg, data: result.data },
        'PalmPay response indicates failure',
      );
    }

    return parsed;
  }

  // ── getBalance ────────────────────────────────────────────────────────────

  async getBalance(): Promise<{ available_ngn: number; frozen_ngn: number; current_ngn: number; unsettle_ngn: number }> {
    const data = await this.post(
      '/api/v2/merchant/manage/account/queryBalance',
      { merchantId: this.config.merchant_id },
      PalmpayQueryBalanceResponseSchema,
    );

    if (data.respCode !== PALMPAY_RESP_CODE_SUCCESS) {
      throw new Error(`PalmPay queryBalance failed: ${data.respCode} ${data.respMsg}`);
    }

    return {
      available_ngn: data.data?.availableBalance ?? 0,
      frozen_ngn:    data.data?.frozenBalance    ?? 0,
      current_ngn:   data.data?.currentBalance   ?? 0,
      unsettle_ngn:  data.data?.unSettleBalance   ?? 0,
    };
  }

  // ── lookupAccountName ──────────────────────────────────────────────────────

  async lookupAccountName(params: {
    bank_code: string;
    account_number: string;
  }): Promise<string | null> {
    const data = await this.post(
      '/api/v2/payment/merchant/payout/queryBankAccount',
      { bankCode: params.bank_code, bankAccNo: params.account_number },
      PalmpayQueryBankAccountResponseSchema,
    );

    if (data.respCode !== PALMPAY_RESP_CODE_SUCCESS) {
      this.logger.warn(`lookupAccountName failed: ${data.respCode} ${data.respMsg}`);
      return null;
    }

    return data.data?.accountName ?? null;
  }

  // ── initiateTransfer ───────────────────────────────────────────────────────

  async initiateTransfer(params: {
    amount: Decimal;
    currency: string;
    provider_name: string;
    account_unique: string;
    account_name: string | null;
    reference: string;
    narration: string;
  }): Promise<{ provider_txn_id: string; provider_response: Record<string, unknown> }> {
    const data = await this.post(
      '/api/v2/merchant/payment/payout',
      {
        orderId: params.reference,
        amount: params.amount.toDecimalPlaces(2).toNumber(),
        currency: params.currency,
        payeeBankCode: params.provider_name,
        payeeBankAccNo: params.account_unique,
        payeeName: params.account_name ?? '',
        notifyUrl: this.config.notify_url,
        remark: params.narration,
      },
      PalmpayPayoutResponseSchema,
    );

    if (data.respCode !== PALMPAY_RESP_CODE_SUCCESS) {
      throw new Error(`PalmPay payout failed: ${data.respCode} ${data.respMsg}`);
    }

    return {
      provider_txn_id: data.data?.orderNo ?? '',  // PalmPay's internal ID
      provider_response: data as unknown as Record<string, unknown>,
    };
  }

  // ── getTransferStatus ──────────────────────────────────────────────────────

  async getTransferStatus(provider_reference: string): Promise<{
    status: 'processing' | 'successful' | 'failed';
    failure_reason?: string;
    failure_code?: string;
  }> {
    const data = await this.post(
      '/api/v2/merchant/payment/queryPayStatus',
      { orderNo: provider_reference },
      PalmpayQueryPayStatusResponseSchema,
    );

    const order_status = data.data?.orderStatus;

    if (order_status === PALMPAY_ORDER_STATUS_SUCCESS) return { status: 'successful' };
    if (order_status === PALMPAY_ORDER_STATUS_FAILED) {
      return {
        status: 'failed',
        failure_reason: data.data?.message,
        failure_code: data.respCode,
      };
    }
    return { status: 'processing' };
  }

  // ── createVirtualAccount ──────────────────────────────────────────────────
  // Creates a PalmPay-assigned NGN virtual bank account linked to the customer's
  // BVN. accountReference is stored by us (e.g. loan_id) to match inbound payments.

  async createVirtualAccount(params: {
    virtual_account_name: string;
    identity_type: string;     // 'BVN' | 'NIN'
    license_number: string;    // BVN or NIN value — never logged
    customer_name: string;
    account_reference: string;
  }): Promise<{ virtual_account_no: string; virtual_account_name: string }> {
    const data = await this.post(
      '/api/v2/virtual/account/label/create',
      {
        virtualAccountName: params.virtual_account_name,
        identityType:       params.identity_type,
        licenseNumber:      params.license_number,
        customerName:       params.customer_name,
        accountReference:   params.account_reference,
      },
      PalmpayCreateVirtualAccountResponseSchema,
    );

    if (data.respCode !== PALMPAY_RESP_CODE_SUCCESS) {
      throw new Error(`PalmPay createVirtualAccount failed: ${data.respCode} ${data.respMsg}`);
    }

    return {
      virtual_account_no:   data.data?.virtualAccountNo   ?? '',
      virtual_account_name: data.data?.virtualAccountName ?? params.virtual_account_name,
    };
  }

  // ── verifyWebhookSignature ─────────────────────────────────────────────────

  verifyWebhookSignature(raw_body: string, _signature: string): boolean {
    try {
      const params = JSON.parse(raw_body) as Record<string, unknown>;
      const { sign } = params;
      // Payout notifications always include sign (required).
      // Collection (payin) notifications mark sign as optional — skip
      // verification only when the field is genuinely absent, not when
      // it is present but invalid.
      if (sign === undefined || sign === null) return true;
      if (typeof sign !== 'string') return false;
      return this.verify_webhook_sign(params, sign);
    } catch {
      return false;
    }
  }
}
