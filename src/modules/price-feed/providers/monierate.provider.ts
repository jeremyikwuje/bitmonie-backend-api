import { AssetPair } from '@prisma/client';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { PriceFeedProvider, RateResult } from './price-feed.provider.interface';

const SATS_PER_BTC = new Decimal('100000000');

// Monierate API response schema — update if actual API shape differs
const MonierateEntrySchema = z.object({
  slug: z.string(),
  buy: z.number().positive(),
  sell: z.number().positive(),
  created_at: z.string().optional(),
});

const MonierateResponseSchema = z.object({
  status: z.literal(true),
  data: z.array(MonierateEntrySchema),
});

const SLUG_TO_PAIR: Record<string, AssetPair> = {
  'BTC-NGN': AssetPair.BTC_NGN,
  'USDT-NGN': AssetPair.USDT_NGN,
};

export class MonierateProvider implements PriceFeedProvider {
  constructor(
    private readonly api_key: string,
    private readonly base_url: string,
  ) {}

  async fetchRates(): Promise<RateResult[]> {
    const response = await fetch(`${this.base_url}/v1/pairs`, {
      headers: { 'api-key': this.api_key, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Monierate API error: ${response.status} ${response.statusText}`);
    }

    const raw: unknown = await response.json();
    const parsed = MonierateResponseSchema.safeParse(raw);

    if (!parsed.success) {
      throw new Error(`Monierate response validation failed: ${parsed.error.message}`);
    }

    const results: RateResult[] = [];
    const fetched_at = new Date();

    for (const entry of parsed.data.data) {
      const pair = SLUG_TO_PAIR[entry.slug.toUpperCase()];
      if (!pair) continue;

      results.push({
        pair,
        rate_buy: new Decimal(entry.buy),
        rate_sell: new Decimal(entry.sell),
        fetched_at,
      });

      if (pair === AssetPair.BTC_NGN) {
        results.push({
          pair: AssetPair.SAT_NGN,
          rate_buy: new Decimal(entry.buy).dividedBy(SATS_PER_BTC),
          rate_sell: new Decimal(entry.sell).dividedBy(SATS_PER_BTC),
          fetched_at,
        });
      }
    }

    if (results.length === 0) {
      throw new Error('Monierate returned no usable rate pairs');
    }

    return results;
  }
}
