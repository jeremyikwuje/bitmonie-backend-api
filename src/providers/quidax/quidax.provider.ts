import { AssetPair } from '@prisma/client';
import Decimal from 'decimal.js';
import type { PriceFeedProvider, RateResult } from '@/modules/price-feed/price-feed.provider.interface';
import { QuidaxResponseSchema } from './quidax.types';

const SATS_PER_BTC = new Decimal('100000000');

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

    const fetched_at = new Date();
    const { btcngn, usdtngn } = parsed.data.data;

    return [
      {
        pair: AssetPair.BTC_NGN,
        rate_buy: new Decimal(btcngn.ticker.sell),
        rate_sell: new Decimal(btcngn.ticker.buy),
        fetched_at,
      },
      {
        pair: AssetPair.SAT_NGN,
        rate_buy: new Decimal(btcngn.ticker.sell).div(SATS_PER_BTC),
        rate_sell: new Decimal(btcngn.ticker.buy).div(SATS_PER_BTC),
        fetched_at,
      },
      {
        pair: AssetPair.USDT_NGN,
        rate_buy: new Decimal(usdtngn.ticker.sell),
        rate_sell: new Decimal(usdtngn.ticker.buy),
        fetched_at,
      },
    ];
  }
}
