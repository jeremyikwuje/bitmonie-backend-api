import { AssetPair } from '@prisma/client';
import Decimal from 'decimal.js';
import type { PriceFeedProvider, RateResult } from '@/modules/price-feed/price-feed.provider.interface';
import { QuidaxResponseSchema } from './quidax.types';

const SATS_PER_BTC = new Decimal('100000000');

const SLUG_TO_PAIR: Record<string, AssetPair> = {
  BTCNGN: AssetPair.BTC_NGN,
  USDTNGN: AssetPair.USDT_NGN,
};

export class QuidaxProvider implements PriceFeedProvider {
  constructor(private readonly config: { api_key: string; base_url: string }) {}

  async fetchRates(): Promise<RateResult[]> {
    const response = await fetch(`${this.config.base_url}/markets/tickers/`, {
      headers: { 'api-key': this.config.api_key, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Price feed API error: ${response.status} ${response.statusText}`);
    }

    const raw: unknown = await response.json();
    const parsed = QuidaxResponseSchema.safeParse(raw);

    if (!parsed.success) {
      throw new Error(`Price feed response validation failed: ${parsed.error.message}`);
    }

    const results: RateResult[] = [];
    const fetched_at = new Date();

    for (const [slug, pair_data] of Object.entries(parsed.data.data)) {
      const pair = SLUG_TO_PAIR[slug.toUpperCase()];
      if (!pair) continue;

      results.push({
        pair,
        rate_buy: new Decimal(pair_data.ticker.sell),
        rate_sell: new Decimal(pair_data.ticker.buy),
        fetched_at,
      });

      if (pair === AssetPair.BTC_NGN) {
        results.push({
          pair: AssetPair.SAT_NGN,
          rate_buy: new Decimal(pair_data.ticker.sell).div(SATS_PER_BTC),
          rate_sell: new Decimal(pair_data.ticker.buy).div(SATS_PER_BTC),
          fetched_at,
        });
      }
    }

    if (results.length === 0) {
      throw new Error('Price feed returned no usable rate pairs');
    }

    return results;
  }
}
