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
  PalmpayQueryCollectionOrderResponseSchema,
  PalmpayCreateVirtualAccountResponseSchema,
  PALMPAY_RESP_CODE_SUCCESS,
  PALMPAY_ORDER_STATUS_SUCCESS,
  PALMPAY_ORDER_STATUS_FAILED,
  PALMPAY_COLLECTION_STATUS_SUCCESS,
  PALMPAY_COLLECTION_STATUS_FAILED,
  PALMPAY_PAYOUT_NOTIFY_URL,
} from './palmpay.types';

// PalmPay's createVirtualAccount response does not include the host bank's
// human-readable name. For PalmPay-hosted VAs the partner bank visible on
// the customer's banking-app transfer screen is Bloom MFB. Centralised here
// so the same default backs both the provider return value and the
// schema-level column default — keeps the two in lockstep.
const PALMPAY_VA_DEFAULT_BANK_NAME = 'Bloom Microfinance Bank';

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

  // PalmPay's dashboard hands the platform public key out as bare
  // base64-encoded X.509 SubjectPublicKeyInfo DER — NO PEM BEGIN/END
  // headers — so a strict PEM parse silently fails and every webhook
  // gets rejected as UNAUTHORIZED. Accept either format and trim any
  // whitespace/newlines that may have crept in via env-var copy-paste.
  private load_webhook_pub_key(): forge.pki.rsa.PublicKey {
    const raw = (this.config.webhook_pub_key ?? '').trim();
    if (raw === '') {
      throw new Error('PalmPay webhook public key is not configured (PALMPAY_WEBHOOK_PUB_KEY)');
    }
    if (raw.includes('-----BEGIN')) {
      return forge.pki.publicKeyFromPem(raw) as forge.pki.rsa.PublicKey;
    }
    const der_bytes = forge.util.decode64(raw.replace(/\s+/g, ''));
    const asn1 = forge.asn1.fromDer(der_bytes);
    return forge.pki.publicKeyFromAsn1(asn1) as forge.pki.rsa.PublicKey;
  }

  private verify_webhook_sign(params: Record<string, unknown>, signature: string): boolean {
    let public_key: forge.pki.rsa.PublicKey;
    try {
      public_key = this.load_webhook_pub_key();
    } catch (err) {
      // Bad key config is operator error, not a tampered payload — surface
      // the cause loudly so it doesn't masquerade as a signature mismatch.
      this.logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'PalmPay webhook public key failed to load — every signature will fail until this is fixed',
      );
      return false;
    }

    try {
      // Match PalmPay's signing spec exactly: drop the sign field, exclude
      // null/undefined/empty values (asymmetric handling here would break
      // verification on any payload with optional fields PalmPay omitted),
      // sort keys ascending, join as key=value&… .
      const { sign: _, ...rest } = params;
      const sorted = Object.keys(rest)
        .filter((k) => rest[k] !== undefined && rest[k] !== null && rest[k] !== '')
        .sort()
        .map((k) => `${k}=${String(rest[k])}`)
        .join('&');
      const md5 = crypto.createHash('md5').update(sorted, 'utf8').digest('hex').toUpperCase();

      const md = forge.md.sha1.create();
      md.update(md5, 'utf8');
      // sign in webhook payload is URL-encoded base64
      const raw_sig = forge.util.decode64(decodeURIComponent(signature));
      return public_key.verify(md.digest().bytes(), raw_sig);
    } catch (err) {
      this.logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'PalmPay webhook signature verification threw — treating as invalid',
      );
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

    // Account number is omitted from this log per §5.8; notify_url and
    // reference are not PII. notify_url is pinned to the prod controller in
    // PALMPAY_PAYOUT_NOTIFY_URL — kept in the log so a dashboard/code drift
    // surfaces in the outbound trace.
    this.logger.log(
      {
        reference:    params.reference,
        amount_kobo,
        currency:     params.currency,
        bank_code:    params.provider_code,
        notify_url:   PALMPAY_PAYOUT_NOTIFY_URL,
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
        notifyUrl: PALMPAY_PAYOUT_NOTIFY_URL,
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

  // ── getCollectionOrderStatus ──────────────────────────────────────────────
  // Defence-in-depth re-query of an inbound payin order. Called from the
  // collection webhook BEFORE we credit a customer's loan, so we never act on
  // a webhook claim alone — same verify-before-act discipline as the payout
  // path's getTransferStatus(). PalmPay's webhook signature already proves
  // the payload originated with PalmPay, but this guards against:
  //   1. signed-but-stale replays an attacker mirrors back at us;
  //   2. provider-side races where the webhook fires before settlement;
  //   3. tenant-side bugs where the platform mis-flags an order as success.
  //
  // Returns CENTS in `amount_kobo` so
  // the caller does the divide-by-100 once with Decimal.
  async getCollectionOrderStatus(order_no: string): Promise<{
    status:           'successful' | 'failed' | 'unknown';
    amount_kobo?:     number;
    currency?:        string;
    virtual_account_no?: string;
    payer_account_name?: string;
    failure_reason?:  string;
  }> {
    const data = await this.post(
      '/api/v2/virtual/order/detail',
      { orderNo: order_no },
      PalmpayQueryCollectionOrderResponseSchema,
    );

    const order_status = data.data?.orderStatus;

    // PalmPay payin query responses don't echo the payer account number — we
    // log payer name (already non-PII per redaction rules) and the status
    // payload so a stuck row is debuggable.
    this.logger.log(
      {
        order_no,
        respCode:    data.respCode,
        respMsg:     data.respMsg,
        orderStatus: order_status,
        orderAmount: data.data?.orderAmount,
        currency:    data.data?.currency,
        sessionId:   data.data?.sessionId,
      },
      'PalmPay queryCollectionOrder response',
    );

    if (data.respCode !== PALMPAY_RESP_CODE_SUCCESS) {
      // respCode != 00000000 means PalmPay couldn't query the order at all
      // (auth, signing, transient). Don't treat as "failed" — the upstream
      // webhook claim is unverified. Caller defers and PalmPay will retry.
      return { status: 'unknown', failure_reason: `${data.respCode} ${data.respMsg}` };
    }

    if (order_status === PALMPAY_COLLECTION_STATUS_SUCCESS) {
      return {
        status:               'successful',
        amount_kobo:          data.data?.orderAmount,
        currency:             data.data?.currency,
        virtual_account_no:   data.data?.virtualAccountNo,
        payer_account_name:   data.data?.payerAccountName,
      };
    }

    if (order_status === PALMPAY_COLLECTION_STATUS_FAILED) {
      return { status: 'failed', failure_reason: data.data?.message };
    }

    // respCode=success + missing orderStatus or unrecognised code → don't act.
    // Distinct from a definitive "failed" so the caller can defer rather than
    // page ops.
    this.logger.warn(
      { order_no, respCode: data.respCode, orderStatus: order_status },
      'PalmPay queryCollectionOrder returned success with no recognised orderStatus — treating as unknown',
    );
    return { status: 'unknown' };
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
  }): Promise<{ virtual_account_no: string; virtual_account_name: string; bank_name: string }> {
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
      bank_name:            PALMPAY_VA_DEFAULT_BANK_NAME,
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
