import { z } from 'zod';

// orderStatus numeric codes used across query-pay-status and webhook
// 1 = Processing, 2 = Success, 3 = Failed
export const PALMPAY_ORDER_STATUS_SUCCESS    = 2;
export const PALMPAY_ORDER_STATUS_FAILED     = 3;
export const PALMPAY_RESP_CODE_SUCCESS       = '00000000';

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
//   accountReference — the reference we set on the virtual account; used to
//                      match the inbound payment to a loan or offramp order
//   sign         — optional; verify with platform public key when present
export const PalmpayCollectionNotificationSchema = z.object({
  orderNo:           z.string(),              // PalmPay platform order number
  orderStatus:       z.number(),             // Virtual account order status
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
  sign:              z.string().optional(),  // RSA signature — verify when present
});

export type PalmpayCollectionNotification = z.infer<typeof PalmpayCollectionNotificationSchema>;

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
