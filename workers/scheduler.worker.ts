/**
 * Scheduler Worker — standalone Node.js process (NOT NestJS).
 *
 * Runs the periodic non-payout jobs in a single process:
 *   - loan-expiry                 — every WORKER_LOAN_EXPIRY_INTERVAL_MS            (default 60s)
 *   - loan-reminder               — every WORKER_LOAN_REMINDER_INTERVAL_MS          (default 1h)
 *   - disbursement-on-hold-digest — every WORKER_DISBURSEMENT_DIGEST_INTERVAL_MS    (default 24h)
 *   - outflow-reconciler          — every WORKER_OUTFLOW_RECONCILER_INTERVAL_MS     (default 60s)
 *
 * Each cycle is the same `run*Cycle` function the standalone worker entry points
 * call — single source of truth, no duplication. Shared Prisma client, Redis
 * client, and email provider are constructed once and passed to every cycle.
 *
 * outflow-reconciler runs here despite touching financial state because it
 * never *creates* a payout — it polls providers for ground-truth status and
 * routes the answer through OutflowsService.handleSuccess / handleFailure
 * (the same code paths the webhook controllers use). Failure mode is "stale
 * PROCESSING rows take an extra cycle to reconcile," not lost money.
 *
 * The two workers that *originate* money movement (liquidation-monitor,
 * price-feed) stay as their own Railway services for fault isolation. See
 * railway/README.md.
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
import type { EmailProvider, TransactionalEmailParams } from '@/modules/auth/email.provider.interface';
import { EMAIL_PROVIDER_CONFIG, EmailProviderName } from '@/config/email.config';
import { DisbursementProviderName } from '@/config/disbursement.config';
import { PalmpayProvider } from '@/providers/palmpay/palmpay.provider';
import { StubDisbursementProvider } from '@/providers/stub/stub-disbursement.provider';
import { DisbursementsService } from '@/modules/disbursements/disbursements.service';
import { DisbursementRouter } from '@/modules/disbursements/disbursement-router.service';
import { OutflowsService } from '@/modules/disbursements/outflows.service';
import type { DisbursementProvider } from '@/modules/disbursements/disbursement.provider.interface';
import type { PrismaService } from '@/database/prisma.service';

import { runExpiryCycle, type LoanExpiryDeps } from './loan-expiry.worker';
import { runReminderCycle, type LoanReminderDeps, type SendEmail } from './loan-reminder.worker';
import { runDigestCycle, type DigestDeps } from './disbursement-on-hold-digest.worker';
import { runReconcilerCycle, type ReconcilerDeps } from './outflow-reconciler.worker';

const LOAN_EXPIRY_INTERVAL_MS   = parseInt(process.env.WORKER_LOAN_EXPIRY_INTERVAL_MS         ?? '60000',          10);
const LOAN_REMINDER_INTERVAL_MS = parseInt(process.env.WORKER_LOAN_REMINDER_INTERVAL_MS       ?? '3600000',        10);
const DIGEST_INTERVAL_MS        = parseInt(process.env.WORKER_DISBURSEMENT_DIGEST_INTERVAL_MS ?? String(24 * 60 * 60 * 1000), 10);
const RECONCILER_INTERVAL_MS    = parseInt(process.env.WORKER_OUTFLOW_RECONCILER_INTERVAL_MS  ?? '60000',          10);

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
        from_address: process.env.MAILGUN_FROM_ADDRESS ?? '',
        from_name:    process.env.MAILGUN_FROM_NAME    ?? 'Bitmonie',
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
  const send_email: SendEmail = (params: TransactionalEmailParams) => email_provider.sendTransactional(params);
  const alerts = new OpsAlertsService(email_provider, new WorkerConfigService() as unknown as ConfigService);

  const expiry_deps:   LoanExpiryDeps   = { prisma, redis, log: jobLogger('loan_expiry') };
  const reminder_deps: LoanReminderDeps = { prisma, redis, send_email, log: jobLogger('loan_reminder') };
  const digest_deps:   DigestDeps       = { prisma, redis, alerts,    log: jobLogger('disbursement_digest') };

  // Outflow reconciler — provider lookup keyed by the snapshot string written
  // to outflow.provider at dispatch time, so a per-attempt provider can be
  // resolved without going through DisbursementRouter (the chosen provider is
  // already pinned per outflow row).
  const prisma_as_service = prisma as unknown as PrismaService;
  const palmpay = new PalmpayProvider({
    app_id:               process.env.PALMPAY_APP_ID                ?? '',
    merchant_id:          process.env.PALMPAY_MERCHANT_ID           ?? '',
    private_key:          process.env.PALMPAY_PRIVATE_KEY           ?? '',
    public_key:           process.env.PALMPAY_PUBLIC_KEY            ?? '',
    webhook_pub_key:      process.env.PALMPAY_WEBHOOK_PUB_KEY       ?? '',
    base_url:             process.env.PALMPAY_BASE_URL              ?? 'https://open-gw-prod.palmpay-inc.com',
    notify_url:           process.env.PALMPAY_NOTIFY_URL            ?? '',
    webhook_ip_allowlist: (process.env.PALMPAY_WEBHOOK_IP_ALLOWLIST ?? '')
      .split(',').map((s) => s.trim()).filter((s) => s.length > 0),
  });
  const stub_disbursement = new StubDisbursementProvider(prisma_as_service);
  const disbursement_providers = new Map<string, DisbursementProvider>([
    [DisbursementProviderName.Palmpay, palmpay],
    [DisbursementProviderName.Stub,    stub_disbursement],
  ]);
  const disbursements_service = new DisbursementsService(prisma_as_service);
  const disbursement_router   = new DisbursementRouter(disbursement_providers);
  const outflows_service      = new OutflowsService(prisma_as_service, disbursements_service, disbursement_router, alerts);
  const reconciler_deps: ReconcilerDeps = {
    prisma,
    redis,
    outflows:  outflows_service,
    providers: disbursement_providers,
    log:       jobLogger('outflow_reconciler'),
  };

  log('info', 'started', {
    intervals: {
      loan_expiry_ms:         LOAN_EXPIRY_INTERVAL_MS,
      loan_reminder_ms:       LOAN_REMINDER_INTERVAL_MS,
      disbursement_digest_ms: DIGEST_INTERVAL_MS,
      outflow_reconciler_ms:  RECONCILER_INTERVAL_MS,
    },
    email_provider: EMAIL_PROVIDER_CONFIG,
  });

  await redis.ping();

  // Run each cycle once on boot, then on its own interval. Failures in one job
  // never affect the others.
  await Promise.allSettled([
    runExpiryCycle(expiry_deps).catch((err)        => log('error', 'unhandled_error', { job: 'loan_expiry',         error: String(err) })),
    runReminderCycle(reminder_deps).catch((err)    => log('error', 'unhandled_error', { job: 'loan_reminder',       error: String(err) })),
    runDigestCycle(digest_deps).catch((err)        => log('error', 'unhandled_error', { job: 'disbursement_digest', error: String(err) })),
    runReconcilerCycle(reconciler_deps).catch((err) => log('error', 'unhandled_error', { job: 'outflow_reconciler', error: String(err) })),
  ]);

  schedule('loan_expiry',         LOAN_EXPIRY_INTERVAL_MS,   () => runExpiryCycle(expiry_deps));
  schedule('loan_reminder',       LOAN_REMINDER_INTERVAL_MS, () => runReminderCycle(reminder_deps));
  schedule('disbursement_digest', DIGEST_INTERVAL_MS,        () => runDigestCycle(digest_deps));
  schedule('outflow_reconciler',  RECONCILER_INTERVAL_MS,    () => runReconcilerCycle(reconciler_deps));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Scheduler failed to start:', err);
    process.exit(1);
  });
}
