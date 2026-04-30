import Decimal from 'decimal.js';
import { z } from 'zod';

// Reject non-positive / unparseable rates at the schema boundary so a broken
// upstream snapshot can't cascade into Redis and trigger spurious liquidations.
const PositiveDecimalString = z.string().refine(
  (s) => {
    try {
      return new Decimal(s).gt(0);
    } catch {
      return false;
    }
  },
  { message: 'expected a positive decimal string' },
);

// Quidax returns ticker values as numeric strings e.g. "97000000.0"
// and status as the string "success"
export const TickerSchema = z.object({
  buy: PositiveDecimalString,
  sell: PositiveDecimalString,
});

export const TradingPairSchema = z.object({
  at: z.union([z.string(), z.number()]).optional(),
  ticker: TickerSchema,
});

// Quidax /markets/tickers/ returns every listed market — including illiquid
// pairs (qdxngn, btcghs, shibusdt, ...) that occasionally quote "0". Validate
// only the pairs we consume; anything else passes through unread. Strictness
// on btcngn / usdtngn is intentional — a zero or malformed quote on either is
// a real upstream incident and should kill the cycle.
export const QuidaxDataSchema = z
  .object({
    btcngn: TradingPairSchema,
    usdtngn: TradingPairSchema,
  })
  .passthrough();

export const QuidaxResponseSchema = z.object({
  status: z.literal('success'),
  message: z.string().optional(),
  data: QuidaxDataSchema,
});

export type QuidaxResponse = z.infer<typeof QuidaxResponseSchema>;
