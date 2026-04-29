import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as forge from 'node-forge';
import { Decimal } from 'decimal.js';
import type { PalmpayConfig } from '@/config/providers.config';
import type { Bank, DisbursementProvider } from '@/modules/disbursements/disbursement.provider.interface';
import type { CollectionIdentityType } from '@/modules/loans/collection.provider.interface';
import {
  PalmpayQueryBankAccountResponseSchema,
  PalmpayPayoutResponseSchema,
  PalmpayQueryPayStatusResponseSchema,
  PalmpayQueryBalanceResponseSchema,
  PalmpayQueryBankListResponseSchema,
  PalmpayCreateVirtualAccountResponseSchema,
  PALMPAY_RESP_CODE_SUCCESS,
  PALMPAY_ORDER_STATUS_SUCCESS,
  PALMPAY_ORDER_STATUS_FAILED,
} from './palmpay.types';

// Bank list rarely changes upstream (new PSPs/MFBs trickle in over weeks).
// Cache the parsed list in-memory so the public /banks endpoint stays cheap
// and survives short PalmPay blips. TTL is short enough that a newly-onboarded
// PSP shows up on the next hot reload.
const PALMPAY_BANK_LIST_CACHE_TTL_MS = 60 * 60 * 1000;

function nonce_str(): string {
  return crypto.randomBytes(16).toString('hex');
}

@Injectable()
export class PalmpayProvider implements DisbursementProvider {
  private readonly logger = new Logger(PalmpayProvider.name);

  // In-memory cache for listBanks(). PalmPay's bank catalogue is small,
  // public, and rarely changes — re-fetching on every dropdown render
  // would be wasteful and would expose us to upstream blips. `expires_at`
  // is checked on each call; a miss re-fetches in-band on the next caller.
  private bank_list_cache: { banks: Bank[]; expires_at: number } | null = null;

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

  // ── listBanks ─────────────────────────────────────────────────────────────
  // Returns the catalogue of payout destinations PalmPay can route to in NG.
  // businessType=0 ("all") includes commercial banks, MFBs, and mobile-money
  // wallets — they share the same bankCode/bankName shape and are accepted
  // uniformly by the payout endpoint via payeeBankCode.
  async listBanks(): Promise<Bank[]> {
    const now = Date.now();
    if (this.bank_list_cache && this.bank_list_cache.expires_at > now) {
      return this.bank_list_cache.banks;
    }

    const data = await this.post(
      '/api/v2/general/merchant/queryBankList',
      { businessType: '0' },
      PalmpayQueryBankListResponseSchema,
    );

    if (data.respCode !== PALMPAY_RESP_CODE_SUCCESS) {
      throw new Error(`PalmPay queryBankList failed: ${data.respCode} ${data.respMsg}`);
    }

    const banks: Bank[] = (data.data ?? []).map((row) => ({
      code:     row.bankCode,
      name:     row.bankName,
      logo_url: row.bankUrl ?? null,
    }));

    this.bank_list_cache = { banks, expires_at: now + PALMPAY_BANK_LIST_CACHE_TTL_MS };
    return banks;
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
    provider_code: string;
    account_unique: string;
    account_name: string | null;
    reference: string;
    narration: string;
  }): Promise<{ provider_txn_id: string; provider_response: Record<string, unknown> }> {
    // PalmPay expects amount in MINOR units (kobo) for both payout and
    // collection notifications: 1 NGN = 100 kobo. Multiplying by 100 and
    // rounding to integer kobo is the canonical conversion — Decimal handles
    // the multiply precisely; toDecimalPlaces(0) collapses sub-kobo dust that
    // shouldn't exist (you can't physically transfer 0.5 kobo) but defends
    // against floating-point oddities upstream.
    const amount_kobo = params.amount.times(100).toDecimalPlaces(0).toNumber();

    // Verify the webhook callback URL we're handing PalmPay matches the
    // deployed webhook controller route. Empty string here means PalmPay has
    // nothing to call back, so the only way to learn the payout outcome is
    // the reconciler poll. Account number is omitted from this log per §5.8;
    // notify_url and reference are config / our own identifier — not PII.
    this.logger.log(
      {
        reference:    params.reference,
        amount_kobo,
        currency:     params.currency,
        bank_code:    params.provider_code,
        notify_url:   this.config.notify_url || '(empty — webhook callback disabled)',
      },
      'PalmPay payout request — outbound',
    );

    const data = await this.post(
      '/api/v2/merchant/payment/payout',
      {
        orderId: params.reference,
        amount: amount_kobo,
        currency: params.currency,
        payeeBankCode: params.provider_code,
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
    // queryPayStatus matches by either field, but our `provider_reference` is
    // the value we sent as `orderId` on the payout request — sending it as
    // `orderNo` (PalmPay's internal ID) makes them respond respCode=success
    // with data=null because no row matches, and the reconciler then can't
    // tell "not found" apart from "still in flight".
    const data = await this.post(
      '/api/v2/merchant/payment/queryPayStatus',
      { orderId: provider_reference },
      PalmpayQueryPayStatusResponseSchema,
    );

    const order_status = data.data?.orderStatus;

    // Log every parsed status reply so the reconciler's "stuck PROCESSING"
    // path is debuggable. PalmPay queryPayStatus responses don't echo
    // customer account numbers — only orderId/orderNo/orderStatus/message —
    // so this is safe under §5.8. orderStatus codes: 1=processing, 2=success,
    // 3=failed; anything else falls through to "processing" below, which is
    // the most common cause of stuck rows when PalmPay returns a code we
    // don't have mapped.
    this.logger.log(
      {
        provider_reference,
        respCode:    data.respCode,
        respMsg:     data.respMsg,
        orderStatus: order_status,
        orderId:     data.data?.orderId,
        orderNo:     data.data?.orderNo,
        sessionId:   data.data?.sessionId,
        message:     data.data?.message,
      },
      'PalmPay queryPayStatus response',
    );

    if (order_status === PALMPAY_ORDER_STATUS_SUCCESS) return { status: 'successful' };
    if (order_status === PALMPAY_ORDER_STATUS_FAILED) {
      return {
        status: 'failed',
        failure_reason: data.data?.message,
        failure_code: data.respCode,
      };
    }

    // respCode=success + missing/empty data means PalmPay accepted the query
    // but returned no transaction record. Distinct from a genuine
    // orderStatus=1 in-flight reply — surface at warn level so a row stuck
    // for this reason is visible in logs instead of looking like normal
    // PROCESSING noise. Most common cause: querying with a reference PalmPay
    // doesn't recognise (wrong field, malformed ref, or upstream lost it).
    if (
      data.respCode === PALMPAY_RESP_CODE_SUCCESS &&
      (data.data == null || order_status == null)
    ) {
      this.logger.warn(
        {
          provider_reference,
          respCode: data.respCode,
          respMsg:  data.respMsg,
        },
        'PalmPay queryPayStatus returned success with no orderStatus — likely transaction not found',
      );
    }

    return { status: 'processing' };
  }

  // ── createVirtualAccount ──────────────────────────────────────────────────
  // Creates a PalmPay-assigned NGN virtual bank account linked to the customer's
  // BVN. accountReference is stored by us (e.g. loan_id) to match inbound payments.

  async createVirtualAccount(params: {
    virtual_account_name: string;
    identity_type: CollectionIdentityType;
    license_number: string;    // BVN or NIN value — never logged
    customer_name: string;
    account_reference: string;
  }): Promise<{ virtual_account_no: string; virtual_account_name: string }> {
    // PalmPay's wire enum diverges from our role-named identity_type:
    // BVN → "personal", NIN → "personal_nin", CAC (out of scope at v1.1)
    // → "company". Mismatched identityType/licenseNumber pairings are
    // rejected upstream with respCode "00000008" — the bug this guard
    // exists to prevent.
    const identity_type_wire =
      params.identity_type === 'BVN' ? 'personal' : 'personal_nin';

    const data = await this.post(
      '/api/v2/virtual/account/label/create',
      {
        virtualAccountName: params.virtual_account_name,
        identityType:       identity_type_wire,
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
