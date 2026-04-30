import { z } from 'zod';

// orderStatus numeric codes — semantics DIVERGE between payout and collection.
//
// Payout / queryPayStatus (outbound transfer):
//   1 = Processing, 2 = Success, 3 = Failed
//
// Collection / virtual-account payin notification (inbound customer transfer):
//   1 = Success, 2 = Failed (the "processing" state never reaches the merchant —
//                            PalmPay only fires the webhook once funds have
//                            settled into the VA)
//
// Reusing PALMPAY_ORDER_STATUS_SUCCESS (=2) on a collection payload silently
// drops every successful repayment. Always use PALMPAY_COLLECTION_STATUS_SUCCESS
// (=1) on a collection payload.
export const PALMPAY_ORDER_STATUS_SUCCESS      = 2;   // payout success
export const PALMPAY_ORDER_STATUS_FAILED       = 3;   // payout failed
export const PALMPAY_COLLECTION_STATUS_SUCCESS = 1;   // collection success (DO NOT use on payouts)
export const PALMPAY_COLLECTION_STATUS_FAILED  = 2;   // collection failed
export const PALMPAY_RESP_CODE_SUCCESS         = '00000000';

// Hardcoded payout callback URL passed to PalmPay as the `notifyUrl` field on
// every payout request. Pinned to the production host so the URL cannot drift
// from the controller path it must match (PalmpayPayoutWebhookController →
// /v1/webhooks/palmpay/payout). Dev runs the stub provider so it never reaches
// here; staging hitting this URL ends up at the prod controller, which logs
// the unknown orderId and ignores it — harmless. If you ever need a per-env
// callback, swap this back to `config.notify_url` rather than overloading the
// constant with environment logic.
export const PALMPAY_PAYOUT_NOTIFY_URL = 'https://bitmonie-api.monierate.xyz/v1/webhooks/palmpay/payout';

// ── Query bank account ────────────────────────────────────────────────────────

// PalmPay returns `data: null` (not omitted) on every error response, so all
// these schemas use .nullish() to admit null + undefined + the success shape.
// The respCode/respMsg pair is the source of truth for success vs failure —
// data is only populated on success.

export const PalmpayQueryBankAccountResponseSchema = z.object({
  respCode: z.string(),
  respMsg: z.string(),
  data: z
    .object({
      Status: z.string().optional(),       // 'Success' | 'Failed'
      accountName: z.string().optional(),
    })
    .nullish(),
});

export type PalmpayQueryBankAccountResponse = z.infer<
  typeof PalmpayQueryBankAccountResponseSchema
>;

// ── Payout ───────────────────────────────────────────────────────────────────

export const PalmpayPayoutResponseSchema = z.object({
  respCode: z.string(),
  respMsg: z.string(),
  data: z
    .object({
      orderId: z.string().optional(),      // our reference echoed back
      orderNo: z.string().optional(),      // PalmPay internal transaction ID
      orderStatus: z.number().optional(),
      sessionId: z.string().optional(),
    })
    .nullish(),
});

export type PalmpayPayoutResponse = z.infer<typeof PalmpayPayoutResponseSchema>;

// ── Query pay status ─────────────────────────────────────────────────────────

export const PalmpayQueryPayStatusResponseSchema = z.object({
  respCode: z.string(),
  respMsg: z.string(),
  data: z
    .object({
      currency: z.string().optional(),
      amount: z.number().optional(),
      fee: z.object({ fee: z.number() }).optional(),
      orderId: z.string().optional(),      // our reference echoed back
      orderNo: z.string().optional(),      // PalmPay internal transaction ID
      orderStatus: z.number().optional(),  // 1=processing, 2=success, 3=failed
      sessionId: z.string().optional(),
      message: z.string().optional(),
      createdTime: z.number().optional(),
      completedTime: z.number().optional(),
    })
    .nullish(),
});

export type PalmpayQueryPayStatusResponse = z.infer<
  typeof PalmpayQueryPayStatusResponseSchema
>;

// ── Query bank list ──────────────────────────────────────────────────────────
// PalmPay returns the catalogue of banks and bank-equivalent destinations that
// can be set as the payee on a payout. Some unofficial entries (mobile-money
// wallets, MFBs) are surfaced under the same shape as bank rows. We expose
// them all as banks to the frontend; PalmPay's payout API treats them
// uniformly when bankCode is supplied.
//
// Per the docs, every row carries bankCode + bankName. bankUrl is the brand
// mark; bgUrl/bg2Url are background/list-card variants we don't need.

export const PalmpayQueryBankListResponseSchema = z.object({
  respCode: z.string(),
  respMsg:  z.string(),
  data: z
    .array(
      z.object({
        bankCode: z.string(),
        bankName: z.string(),
        bankUrl:  z.string().nullish(),
      }),
    )
    .nullish(),
});

export type PalmpayQueryBankListResponse = z.infer<
  typeof PalmpayQueryBankListResponseSchema
>;

// ── Query balance ─────────────────────────────────────────────────────────────

export const PalmpayQueryBalanceResponseSchema = z.object({
  respCode: z.string(),
  respMsg: z.string(),
  data: z
    .object({
      availableBalance: z.number().optional(),
      frozenBalance: z.number().optional(),
      currentBalance: z.number().optional(),
      unSettleBalance: z.number().optional(),
    })
    .nullish(),
});

export type PalmpayQueryBalanceResponse = z.infer<
  typeof PalmpayQueryBalanceResponseSchema
>;

// ── Webhook payload ──────────────────────────────────────────────────────────

// ── Payout notification (outbound transfer status update) ────────────────────
// Sent by PalmPay when a payout (disbursement) status changes.
// orderId = our provider_reference ("outflow-{attempt_number}-{disbursement_id}")
export const PalmpayPayoutNotificationSchema = z.object({
  orderId:      z.string(),              // our reference echoed back
  orderNo:      z.string().optional(),   // PalmPay internal transaction ID
  appId:        z.string().optional(),
  currency:     z.string().optional(),
  amount:       z.number().optional(),
  orderStatus:  z.number(),             // 1=processing, 2=success, 3=failed
  sessionId:    z.string().optional(),
  completeTime: z.number().optional(),  // Unix ms timestamp
  message:      z.string().optional(),  // failure reason when orderStatus=3
  sign:         z.string(),
});

export type PalmpayPayoutNotification = z.infer<typeof PalmpayPayoutNotificationSchema>;

// ── Collection notification (inbound virtual account payment) ────────────────
// Sent by PalmPay when a customer pays INTO our virtual account
// (e.g. loan repayment, offramp deposit).
//
// Key fields:
//   orderAmount  — amount in CENTS (100 = 1 NGN); divide by 100 to get NGN
//   orderStatus  — 1 = Success, 2 = Failed (different from payout — see top of file)
//   accountReference — the reference we set on the virtual account; used to
//                      match the inbound payment to a loan or offramp order
//   sign         — optional; verify with platform public key when present
export const PalmpayCollectionNotificationSchema = z.object({
  orderNo:           z.string(),              // PalmPay platform order number
  orderStatus:       z.number(),             // Virtual account order status (1=success, 2=failed)
  createdTime:       z.number(),             // Order create time (Unix ms)
  updateTime:        z.number(),             // Order update time (Unix ms)
  currency:          z.string(),             // NGN
  orderAmount:       z.number(),             // Amount in CENTS — divide by 100 for NGN
  reference:         z.string().optional(),  // Payer reference
  payerAccountNo:    z.string(),             // Payer account number
  payerAccountName:  z.string(),             // Payer account name
  payerBankName:     z.string(),             // Payer bank name
  virtualAccountNo:  z.string().optional(),  // Our virtual account number (if applicable)
  virtualAccountName: z.string().optional(), // Our virtual account name (if applicable)
  accountReference:  z.string().optional(),  // Our reference set on the virtual account
  sessionId:         z.string().optional(),  // Channel response params (not always present)
  appId:             z.string().optional(),  // Echoed back by PalmPay
  sign:              z.string().optional(),  // RSA signature — verify when present
});

export type PalmpayCollectionNotification = z.infer<typeof PalmpayCollectionNotificationSchema>;

// ── Query collection (payin) order ────────────────────────────────────────────
// Defence-in-depth: before crediting an inbound webhook to a customer's loan
// we re-query PalmPay directly with the orderNo so we never act on a webhook
// claim alone. Same verify-before-act discipline used on the payout side
// (queryPayStatus) — if the platform doesn't confirm the order is settled, we
// don't credit. Returns CENTS (matching the webhook's orderAmount), so the
// caller divides by 100 to compare against NGN.
//
// Endpoint: PalmPay's merchant docs list this under the virtual-account /
// collection / payin module. The exact path varies by tenant — confirm against
// the merchant's docs portal before pointing at production. Path constants
// live on the provider so a swap is one-line.
export const PalmpayQueryCollectionOrderResponseSchema = z.object({
  respCode: z.string(),
  respMsg:  z.string(),
  data: z
    .object({
      orderNo:           z.string().optional(),  // PalmPay platform order number
      orderStatus:       z.number().optional(),  // 1=success, 2=failed (collection scheme)
      currency:          z.string().optional(),
      orderAmount:       z.number().optional(),  // CENTS — divide by 100 for NGN
      virtualAccountNo:  z.string().optional(),
      payerAccountNo:    z.string().optional(),
      payerAccountName:  z.string().optional(),
      payerBankName:     z.string().optional(),
      sessionId:         z.string().optional(),
      createdTime:       z.number().optional(),
      updateTime:        z.number().optional(),
      reference:         z.string().optional(),
      accountReference:  z.string().optional(),
      message:           z.string().optional(),
    })
    .nullish(),
});

export type PalmpayQueryCollectionOrderResponse = z.infer<
  typeof PalmpayQueryCollectionOrderResponseSchema
>;

// ── Create virtual account ────────────────────────────────────────────────────
// Used for loan repayments: creates a PalmPay-assigned NGN virtual bank account
// tied to the customer's BVN. accountReference links inbound payments to the loan.

export const PalmpayCreateVirtualAccountResponseSchema = z.object({
  respCode: z.string(),
  respMsg:  z.string(),
  data: z
    .object({
      virtualAccountNo:   z.string().optional(),
      virtualAccountName: z.string().optional(),
      accountReference:   z.string().optional(),
    })
    .nullish(),
});

export type PalmpayCreateVirtualAccountResponse = z.infer<
  typeof PalmpayCreateVirtualAccountResponseSchema
>;

// Legacy alias — kept so existing imports don't break
/** @deprecated Use PalmpayPayoutNotificationSchema */
export const PalmpayWebhookPayloadSchema = PalmpayPayoutNotificationSchema;
export type PalmpayWebhookPayload = PalmpayPayoutNotification;
