/**
 * Scheduler Worker — standalone Node.js process (NOT NestJS).
 *
 * Runs the three non-financial periodic jobs in a single process:
 *   - loan-expiry                 — every WORKER_LOAN_EXPIRY_INTERVAL_MS            (default 60s)
 *                                   (PENDING_COLLATERAL invoice-window expiry,
 *                                    not loan-maturity — duration was removed in v1.2)
 *   - disbursement-on-hold-digest — every WORKER_DISBURSEMENT_DIGEST_INTERVAL_MS    (default 24h)
 *   - webhook-log-prune           — every WORKER_WEBHOOK_LOG_PRUNE_INTERVAL_MS      (default 24h)
 *
 * Each cycle is the same `run*Cycle` function the standalone worker entry points
 * call — single source of truth, no duplication. Shared Prisma client, Redis
 * client, and email provider are constructed once and passed to every cycle.
 *
 * Workers that touch money (liquidation-monitor, outflow-reconciler, price-feed)
 * stay as their own services for fault isolation. See railway/README.md.
 *
 * Run with: ts-node -r tsconfig-paths/register workers/scheduler.worker.ts
 */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { OpsAlertsService } from '@/modules/ops-alerts/ops-alerts.service';
import { MailgunProvider } from '@/providers/mailgun/mailgun.provider';
import { ResendProvider } from '@/providers/resend/resend.provider';
import { PostmarkProvider } from '@/providers/postmark/postmark.provider';
import type { EmailProvider } from '@/modules/auth/email.provider.interface';
import { EMAIL_PROVIDER_CONFIG, EmailProviderName } from '@/config/email.config';

import { runExpiryCycle, type LoanExpiryDeps } from './loan-expiry.worker';
import { runDigestCycle, type DigestDeps } from './disbursement-on-hold-digest.worker';
import { runWebhookLogPruneCycle, type WebhookLogPruneDeps } from './webhook-log-prune.worker';

const LOAN_EXPIRY_INTERVAL_MS         = parseInt(process.env.WORKER_LOAN_EXPIRY_INTERVAL_MS         ?? '60000',                              10);
const DIGEST_INTERVAL_MS              = parseInt(process.env.WORKER_DISBURSEMENT_DIGEST_INTERVAL_MS ?? String(24 * 60 * 60 * 1000),         10);
const WEBHOOK_LOG_PRUNE_INTERVAL_MS   = parseInt(process.env.WORKER_WEBHOOK_LOG_PRUNE_INTERVAL_MS   ?? String(24 * 60 * 60 * 1000),         10);

function log(level: string, event: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(
    JSON.stringify({ level, worker: 'scheduler', event, time: new Date().toISOString(), ...extra }) + '\n',
  );
}

function jobLogger(job: string): (level: string, event: string, extra?: Record<string, unknown>) => void {
  return (level, event, extra = {}) => log(level, event, { job, ...extra });
}

function buildEmailProvider(): EmailProvider {
  switch (EMAIL_PROVIDER_CONFIG) {
    case EmailProviderName.Mailgun:
      return new MailgunProvider({
        api_key:      process.env.MAILGUN_API_KEY      ?? '',
        domain:       process.env.MAILGUN_DOMAIN       ?? '',
        region:       (process.env.MAILGUN_REGION as 'us' | 'eu') ?? 'us',
        from_address: process.env.EMAIL_FROM_ADDRESS ?? '',
        from_name:    process.env.EMAIL_FROM_NAME    ?? 'Bitmonie',
      });
    case EmailProviderName.Resend:
      return new ResendProvider({
        api_key:      process.env.RESEND_API_KEY      ?? '',
        from_address: process.env.RESEND_FROM_ADDRESS ?? '',
        from_name:    process.env.RESEND_FROM_NAME    ?? 'Bitmonie',
      });
    case EmailProviderName.Postmark:
      return new PostmarkProvider({
        server_token:   process.env.POSTMARK_SERVER_TOKEN  ?? '',
        from_address:   process.env.POSTMARK_FROM_ADDRESS  ?? '',
        from_name:      process.env.POSTMARK_FROM_NAME     ?? 'Bitmonie',
        message_stream: process.env.POSTMARK_MESSAGE_STREAM,
      });
  }
}

class WorkerConfigService {
  get<T>(): T {
    return { internal_alert_email: process.env.INTERNAL_ALERT_EMAIL ?? null } as unknown as T;
  }
}

function schedule(name: string, interval_ms: number, run: () => Promise<void>): void {
  setInterval(() => {
    run().catch((err) => log('error', 'unhandled_error', { job: name, error: String(err) }));
  }, interval_ms);
}

async function main(): Promise<void> {
  const DATABASE_URL = process.env.DATABASE_URL;
  const REDIS_URL    = process.env.REDIS_URL;
  if (!DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
  if (!REDIS_URL)    { console.error('REDIS_URL is required');    process.exit(1); }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });
  const redis  = new Redis(REDIS_URL);
  redis.on('error', (err) => log('error', 'redis_error', { error: err.message }));

  const email_provider = buildEmailProvider();
  const alerts = new OpsAlertsService(email_provider, new WorkerConfigService() as unknown as ConfigService);

  const expiry_deps: LoanExpiryDeps      = { prisma, redis, log: jobLogger('loan_expiry') };
  const digest_deps: DigestDeps          = { prisma, redis, alerts, log: jobLogger('disbursement_digest') };
  const prune_deps:  WebhookLogPruneDeps = { prisma, redis, log: jobLogger('webhook_log_prune') };

  log('info', 'started', {
    intervals: {
      loan_expiry_ms:         LOAN_EXPIRY_INTERVAL_MS,
      disbursement_digest_ms: DIGEST_INTERVAL_MS,
      webhook_log_prune_ms:   WEBHOOK_LOG_PRUNE_INTERVAL_MS,
    },
    email_provider: EMAIL_PROVIDER_CONFIG,
  });

  await redis.ping();

  // Run each cycle once on boot, then on its own interval. Failures in one job
  // never affect the others.
  await Promise.allSettled([
    runExpiryCycle(expiry_deps).catch((err)         => log('error', 'unhandled_error', { job: 'loan_expiry',         error: String(err) })),
    runDigestCycle(digest_deps).catch((err)         => log('error', 'unhandled_error', { job: 'disbursement_digest', error: String(err) })),
    runWebhookLogPruneCycle(prune_deps).catch((err) => log('error', 'unhandled_error', { job: 'webhook_log_prune',   error: String(err) })),
  ]);

  schedule('loan_expiry',         LOAN_EXPIRY_INTERVAL_MS,       () => runExpiryCycle(expiry_deps));
  schedule('disbursement_digest', DIGEST_INTERVAL_MS,            () => runDigestCycle(digest_deps));
  schedule('webhook_log_prune',   WEBHOOK_LOG_PRUNE_INTERVAL_MS, () => runWebhookLogPruneCycle(prune_deps));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Scheduler failed to start:', err);
    process.exit(1);
  });
}
