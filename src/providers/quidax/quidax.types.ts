import { z } from 'zod';

// Quidax returns ticker values as numeric strings e.g. "97000000.0"
// and status as the string "success"
export const TickerSchema = z.object({
  buy: z.string(),
  sell: z.string(),
});

export const TradingPairSchema = z.object({
  at: z.union([z.string(), z.number()]).optional(),
  ticker: TickerSchema,
});

export const QuidaxDataSchema = z.record(z.string(), TradingPairSchema);

export const QuidaxResponseSchema = z.object({
  status: z.literal('success'),
  message: z.string().optional(),
  data: QuidaxDataSchema,
});

export type QuidaxResponse = z.infer<typeof QuidaxResponseSchema>;
