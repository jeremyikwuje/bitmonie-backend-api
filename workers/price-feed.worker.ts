/**
 * Price Feed Worker — standalone Node.js process (NOT NestJS).
 * Polls Monierate every WORKER_PRICE_FEED_INTERVAL_MS, writes to DB + Redis.
 * Run with: ts-node -r tsconfig-paths/register workers/price-feed.worker.ts
 */

import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import Decimal from 'decimal.js';
import { z } from 'zod';

const PRICE_CACHE_TTL_SEC = 90;
const PRICE_FEED_STALE_MS = 120_000;
const STALE_ALERT_THRESHOLD_MS = 5 * 60 * 1_000;
const SATS_PER_BTC = new Decimal('100000000');

const WORKER_INTERVAL_MS = parseInt(process.env.WORKER_PRICE_FEED_INTERVAL_MS ?? '30000', 10);
const MONIERATE_API_KEY = process.env.MONIERATE_API_KEY ?? '';
const MONIERATE_BASE_URL = process.env.MONIERATE_BASE_URL ?? 'https://api.monierate.com';
const INTERNAL_ALERT_EMAIL = process.env.INTERNAL_ALERT_EMAIL ?? 'ops@bitmonie.com';
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

if (!DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
if (!REDIS_URL) { console.error('REDIS_URL is required'); process.exit(1); }

const prisma = new PrismaClient();
const redis = new Redis(REDIS_URL);

redis.on('error', (err) => log('error', 'redis_error', { error: err.message }));

// ── Zod schema ─────────────────────────────────────────────────────────────

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

// ── Types ──────────────────────────────────────────────────────────────────

type AssetPair = 'SAT_NGN' | 'BTC_NGN' | 'USDT_NGN' | 'USDC_NGN';

interface RateData {
  pair: AssetPair;
  rate_buy: Decimal;
  rate_sell: Decimal;
  fetched_at: Date;
}

const SLUG_TO_PAIR: Record<string, AssetPair> = {
  'BTC-NGN': 'BTC_NGN',
  'USDT-NGN': 'USDT_NGN',
};

// ── Logging ────────────────────────────────────────────────────────────────

function log(level: string, event: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(
    JSON.stringify({ level, worker: 'price_feed', event, time: new Date().toISOString(), ...extra }) + '\n',
  );
}

// ── Fetch rates from Monierate ─────────────────────────────────────────────

async function fetch_rates(): Promise<RateData[]> {
  const response = await fetch(`${MONIERATE_BASE_URL}/v1/pairs`, {
    headers: { 'api-key': MONIERATE_API_KEY, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Monierate API error: ${response.status} ${response.statusText}`);
  }

  const raw: unknown = await response.json();
  const parsed = MonierateResponseSchema.safeParse(raw);

  if (!parsed.success) {
    throw new Error(`Monierate validation failed: ${parsed.error.message}`);
  }

  const results: RateData[] = [];
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

    if (pair === 'BTC_NGN') {
      results.push({
        pair: 'SAT_NGN',
        rate_buy: new Decimal(entry.buy).dividedBy(SATS_PER_BTC),
        rate_sell: new Decimal(entry.sell).dividedBy(SATS_PER_BTC),
        fetched_at,
      });
    }
  }

  if (results.length === 0) throw new Error('No usable rate pairs returned from Monierate');

  return results;
}

// ── Worker state ───────────────────────────────────────────────────────────

let consecutive_failures = 0;
let stale_since: number | null = null;

// ── Main cycle ─────────────────────────────────────────────────────────────

async function run_cycle(): Promise<void> {
  try {
    const rates = await fetch_rates();

    await Promise.all(
      rates.map((rate) =>
        prisma.priceFeed.create({
          data: {
            pair: rate.pair,
            rate_buy: rate.rate_buy,
            rate_sell: rate.rate_sell,
            fetched_at: rate.fetched_at,
            source: 'monierate',
          },
        }),
      ),
    );

    const pipeline = redis.pipeline();
    for (const rate of rates) {
      pipeline.set(
        `price:${rate.pair}`,
        JSON.stringify({ buy: rate.rate_buy.toFixed(6), sell: rate.rate_sell.toFixed(6) }),
        'EX',
        PRICE_CACHE_TTL_SEC,
      );
    }
    pipeline.del('price:stale');
    pipeline.set('worker:price_feed:last_run', Date.now().toString());
    await pipeline.exec();

    consecutive_failures = 0;
    stale_since = null;

    log('info', 'cycle_success', { pairs: rates.map((r) => r.pair) });
  } catch (err) {
    consecutive_failures++;
    const error = err instanceof Error ? err.message : String(err);

    log('error', 'cycle_failure', { consecutive_failures, error });

    const now = Date.now();
    if (!stale_since) stale_since = now;

    await redis.set('price:stale', String(stale_since)).catch(() => undefined);

    if (now - stale_since > STALE_ALERT_THRESHOLD_MS) {
      log('error', 'stale_alert', {
        alert_recipient: INTERNAL_ALERT_EMAIL,
        stale_duration_ms: now - stale_since,
        consecutive_failures,
      });
      // Reset so next alert fires STALE_ALERT_THRESHOLD_MS from now, not immediately again
      stale_since = now;
    }

    // Emit heartbeat even on failure so the monitor can distinguish dead vs erroring
    await redis.set('worker:price_feed:last_run', String(now)).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  log('info', 'started', { interval_ms: WORKER_INTERVAL_MS });

  // Validate connectivity before first cycle
  await redis.ping();

  // Run immediately, then on interval
  await run_cycle();

  setInterval(() => {
    run_cycle().catch((err) => log('error', 'unhandled_error', { error: String(err) }));
  }, WORKER_INTERVAL_MS);
}

main().catch((err) => {
  console.error('Worker failed to start:', err);
  process.exit(1);
});
