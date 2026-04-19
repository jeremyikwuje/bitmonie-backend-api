import { AssetPair } from '@prisma/client';
import Decimal from 'decimal.js';

export interface RateResult {
  pair: AssetPair;
  rate_buy: Decimal;
  rate_sell: Decimal;
  fetched_at: Date;
}

export interface PriceFeedProvider {
  fetchRates(): Promise<RateResult[]>;
}
