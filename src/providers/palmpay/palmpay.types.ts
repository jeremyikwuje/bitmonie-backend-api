import { z } from 'zod';

// orderStatus numeric codes used across query-pay-status and webhook
// 1 = Processing, 2 = Success, 3 = Failed
export const PALMPAY_ORDER_STATUS_SUCCESS    = 2;
export const PALMPAY_ORDER_STATUS_FAILED     = 3;
export const PALMPAY_RESP_CODE_SUCCESS       = '00000000';

// ── Query bank account ────────────────────────────────────────────────────────

export const PalmpayQueryBankAccountResponseSchema = z.object({
  respCode: z.string(),
  respMsg: z.string(),
  data: z
    .object({
      Status: z.string().optional(),       // 'Success' | 'Failed'
      accountName: z.string().optional(),
    })
    .optional(),
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
      orderId: z.string().optional(),      // PalmPay internal ID
      orderNo: z.string().optional(),      // our reference echoed back
      orderStatus: z.number().optional(),
      sessionId: z.string().optional(),
    })
    .optional(),
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
      orderId: z.string().optional(),      // PalmPay internal ID
      orderNo: z.string().optional(),      // our reference
      orderStatus: z.number().optional(),  // 1=processing, 2=success, 3=failed
      sessionId: z.string().optional(),
      message: z.string().optional(),
      createdTime: z.number().optional(),
      completedTime: z.number().optional(),
    })
    .optional(),
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
    .optional(),
});

export type PalmpayQueryBalanceResponse = z.infer<
  typeof PalmpayQueryBalanceResponseSchema
>;

// ── Webhook payload ──────────────────────────────────────────────────────────

export const PalmpayWebhookPayloadSchema = z.object({
  orderId: z.string(),                     // our reference (outOrderNo sent in payout)
  orderNo: z.string().optional(),          // PalmPay internal ID
  appId: z.string().optional(),
  currency: z.string().optional(),
  amount: z.number().optional(),
  orderStatus: z.number(),                 // 1=processing, 2=success, 3=failed
  sessionId: z.string().optional(),
  completeTime: z.number().optional(),
  sign: z.string(),
});

export type PalmpayWebhookPayload = z.infer<typeof PalmpayWebhookPayloadSchema>;
