import { z } from 'zod';

// ── lnInvoiceCreate ───────────────────────────────────────────────────────────

export const BlinkLnInvoiceCreateResponseSchema = z.object({
  data: z.object({
    lnInvoiceCreate: z.object({
      invoice: z
        .object({
          paymentRequest: z.string(),
          paymentHash: z.string(),
          satoshis: z.number().nullable().optional(),
        })
        .nullable(),
      errors: z.array(z.object({ message: z.string() })),
    }),
  }),
});

export type BlinkLnInvoiceCreateResponse = z.infer<typeof BlinkLnInvoiceCreateResponseSchema>;

// ── lnAddressPaymentSend ──────────────────────────────────────────────────────

export const BlinkLnAddressPaymentSendResponseSchema = z.object({
  data: z.object({
    lnAddressPaymentSend: z.object({
      status: z.enum(['SUCCESS', 'FAILURE', 'PENDING']),
      errors: z.array(
        z.object({
          message: z.string(),
          code: z.string().optional(),
          path: z.string().optional(),
        }),
      ),
    }),
  }),
});

export type BlinkLnAddressPaymentSendResponse = z.infer<
  typeof BlinkLnAddressPaymentSendResponseSchema
>;

// ── onChainAddressCreate ──────────────────────────────────────────────────────

export const BlinkOnchainAddressCreateResponseSchema = z.object({
  data: z.object({
    onChainAddressCreate: z.object({
      address: z.string().nullable(),
      errors: z.array(z.object({ message: z.string() })),
    }),
  }),
});

export type BlinkOnchainAddressCreateResponse = z.infer<
  typeof BlinkOnchainAddressCreateResponseSchema
>;

// ── onChainPaymentSend ────────────────────────────────────────────────────────

export const BlinkOnchainPaymentSendResponseSchema = z.object({
  data: z.object({
    onChainPaymentSend: z.object({
      status: z.enum(['SUCCESS', 'FAILURE', 'PENDING']),
      errors: z.array(z.object({ message: z.string(), code: z.string().optional() })),
    }),
  }),
});

export type BlinkOnchainPaymentSendResponse = z.infer<
  typeof BlinkOnchainPaymentSendResponseSchema
>;

// ── Intraledger payment send (BTC → USD stable-sats swap) ────────────────────

export const BlinkIntraLedgerPaymentSendResponseSchema = z.object({
  data: z.object({
    intraLedgerPaymentSend: z.object({
      status: z.enum(['SUCCESS', 'FAILURE', 'PENDING']),
      errors: z.array(z.object({ message: z.string(), code: z.string().optional() })),
    }),
  }),
});

export type BlinkIntraLedgerPaymentSendResponse = z.infer<
  typeof BlinkIntraLedgerPaymentSendResponseSchema
>;

// ── Inbound webhook ───────────────────────────────────────────────────────────
// Blink delivers webhooks via Svix.
// eventType: 'receive.lightning' | 'receive.onchain' | 'receive.intraledger'
// paymentHash lives inside transaction.initiationVia for lightning events.

export const BlinkWebhookPayloadSchema = z.object({
  accountId: z.string(),
  eventType: z.string(),
  walletId:  z.string(),
  transaction: z.object({
    initiationVia: z.object({
      type:        z.string(),                // 'Lightning' | 'Onchain' | 'Intraledger'
      paymentHash: z.string().optional(),     // lightning payment hash
      txHash:      z.string().optional(),     // onchain tx hash
    }),
    externalId:          z.string().optional(),
    status:              z.string(),
    settlementAmount:    z.number(),
    settlementCurrency:  z.string(),          // 'BTC' | 'USD'
    createdAt:           z.string().optional(),
  }),
});

export type BlinkWebhookPayload = z.infer<typeof BlinkWebhookPayloadSchema>;

// Svix header bundle — serialised as JSON and passed as the `signature` param
// to verifyWebhookSignature() by the webhook controller.
export interface BlinkWebhookHeaders {
  'svix-id': string;
  'svix-timestamp': string;
  'svix-signature': string;
}
