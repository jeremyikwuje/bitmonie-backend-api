import type Decimal from 'decimal.js';

export const PRICE_QUOTE_PROVIDER = 'PRICE_QUOTE_PROVIDER';

// Narrow interface — used for one-off rate quotes at origination, not for the
// background SAT/NGN price-feed loop (that stays on PriceFeedProvider).
// Currently fulfilled by Blink for BTC/USD.
export interface PriceQuoteProvider {
  getBtcUsdRate(): Promise<Decimal>;
}
