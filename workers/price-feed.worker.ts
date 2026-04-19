/**
 * Price Feed Worker — standalone Node.js process (NOT NestJS).
 * Polls the active price feed provider every WORKER_PRICE_FEED_INTERVAL_MS.
 * Writes results to DB + Redis. Sets price:stale flag on consecutive failures.
 * Run with: ts-node -r tsconfig-paths/register workers/price-feed.worker.ts
 */

import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { QuidaxProvider } from '@/providers/quidax/quidax.provider';

const PRICE_CACHE_TTL_SEC = 90;
const STALE_ALERT_THRESHOLD_MS = 5 * 60 * 1_000;

const WORKER_INTERVAL_MS = parseInt(process.env.WORKER_PRICE_FEED_INTERVAL_MS ?? '30000', 10);
const INTERNAL_ALERT_EMAIL = process.env.INTERNAL_ALERT_EMAIL ?? 'ops@bitmonie.com';
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

if (!DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
if (!REDIS_URL) { console.error('REDIS_URL is required'); process.exit(1); }

const prisma = new PrismaClient();
const redis = new Redis(REDIS_URL);
const provider = new QuidaxProvider({
  api_key: process.env.QUIDAX_API_KEY ?? '',
  base_url: process.env.QUIDAX_BASE_URL ?? 'https://app.quidax.io/api/v1',
});

redis.on('error', (err) => log('error', 'redis_error', { error: err.message }));

function log(level: string, event: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(
    JSON.stringify({ level, worker: 'price_feed', event, time: new Date().toISOString(), ...extra }) + '\n',
  );
}

let consecutive_failures = 0;
let stale_since: number | null = null;

async function run_cycle(): Promise<void> {
  try {
    const rates = await provider.fetchRates();

    await Promise.all(
      rates.map((rate) =>
        prisma.priceFeed.create({
          data: {
            pair: rate.pair,
            rate_buy: rate.rate_buy,
            rate_sell: rate.rate_sell,
            fetched_at: rate.fetched_at,
            source: process.env.PRICE_FEED_PROVIDER ?? 'unknown',
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
      stale_since = now;
    }

    await redis.set('worker:price_feed:last_run', String(now)).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  log('info', 'started', { interval_ms: WORKER_INTERVAL_MS });
  await redis.ping();
  await run_cycle();

  setInterval(() => {
    run_cycle().catch((err) => log('error', 'unhandled_error', { error: String(err) }));
  }, WORKER_INTERVAL_MS);
}

main().catch((err) => {
  console.error('Worker failed to start:', err);
  process.exit(1);
});
