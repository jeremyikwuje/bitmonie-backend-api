/**
 * Disbursement On-Hold Digest Worker — standalone Node.js process (NOT NestJS).
 *
 * Once per cycle, list every Disbursement still in ON_HOLD and email a single
 * digest summarizing them to ops. Pairs with the first-transition alert that
 * fires synchronously when an outflow attempt fails — see
 * OutflowsService._markOnHoldAndMaybeAlert. Empty digests are skipped.
 *
 * No state is changed. Read-only over disbursements; no Redis dedup is
 * needed because cadence is one tick per day (default WORKER_INTERVAL_MS =
 * 24h). The alert payload is built by OpsAlertsService — re-using the same
 * helpers the synchronous alert uses keeps body formatting consistent.
 *
 * Run with: ts-node -r tsconfig-paths/register workers/disbursement-on-hold-digest.worker.ts
 */

import { PrismaClient, DisbursementStatus, OutflowStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { REDIS_KEYS } from '@/common/constants';
import {
  OpsAlertsService,
  type DisbursementOnHoldDigestRow,
} from '@/modules/ops-alerts/ops-alerts.service';
import { MailgunProvider } from '@/providers/mailgun/mailgun.provider';
import { ResendProvider } from '@/providers/resend/resend.provider';
import { PostmarkProvider } from '@/providers/postmark/postmark.provider';
import type { EmailProvider } from '@/modules/auth/email.provider.interface';
import { EMAIL_PROVIDER_CONFIG, EmailProviderName } from '@/config/email.config';

// Default: once per day. The reason "first-transition alert + daily digest"
// works is precisely because the digest is paced slowly — anyone touching
// this constant should keep that property in mind.
const WORKER_INTERVAL_MS = parseInt(
  process.env.WORKER_DISBURSEMENT_DIGEST_INTERVAL_MS ?? String(24 * 60 * 60 * 1000),
  10,
);

export interface DigestDeps {
  prisma: PrismaClient;
  redis:  Redis;
  alerts: OpsAlertsService;
  log: (level: string, event: string, extra?: Record<string, unknown>) => void;
}

function defaultLog(level: string, event: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(
    JSON.stringify({ level, worker: 'disbursement_on_hold_digest', event, time: new Date().toISOString(), ...extra }) + '\n',
  );
}

export async function runDigestCycle(deps: DigestDeps): Promise<void> {
  const { prisma, redis, alerts, log } = deps;

  const stuck = await prisma.disbursement.findMany({
    where: { status: DisbursementStatus.ON_HOLD },
    include: {
      outflows: {
        where: { status: OutflowStatus.FAILED },
        orderBy: { attempt_number: 'desc' },
        take: 1,
      },
    },
    orderBy: [{ on_hold_at: 'asc' }, { created_at: 'asc' }],
  });

  await redis.set(REDIS_KEYS.WORKER_HEARTBEAT('disbursement_on_hold_digest'), Date.now().toString());

  if (stuck.length === 0) {
    log('info', 'cycle_complete_empty', {});
    return;
  }

  const rows: DisbursementOnHoldDigestRow[] = stuck.map((d) => {
    const latest_failed = d.outflows[0];
    return {
      disbursement_id: d.id,
      user_id:         d.user_id,
      source_id:       d.source_id,
      amount:          d.amount.toString(),
      currency:        d.currency,
      // on_hold_at is non-null in steady state (set by markOnHold). Falling
      // back to created_at preserves the column non-null for the email body
      // even if a hand-edited row slipped through without it.
      on_hold_at:      d.on_hold_at ?? d.created_at,
      attempt_count:   latest_failed?.attempt_number ?? 0,
      failure_reason:  d.failure_reason ?? latest_failed?.failure_reason ?? null,
    };
  });

  await alerts.alertDisbursementOnHoldDigest(rows);
  log('info', 'cycle_complete', { row_count: rows.length });
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────

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

// Standalone-process shim for ConfigService — OpsAlertsService reads
// config.get<AppConfig>('app')?.internal_alert_email. We give it a get() that
// resolves the only key it actually consults from the env. Avoids loading the
// full Nest config graph in a worker process.
class WorkerConfigService {
  get<T>(): T {
    return { internal_alert_email: process.env.INTERNAL_ALERT_EMAIL ?? null } as unknown as T;
  }
}

async function main(): Promise<void> {
  const DATABASE_URL = process.env.DATABASE_URL;
  const REDIS_URL    = process.env.REDIS_URL;
  if (!DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
  if (!REDIS_URL)    { console.error('REDIS_URL is required');    process.exit(1); }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });
  const redis  = new Redis(REDIS_URL);
  redis.on('error', (err) => defaultLog('error', 'redis_error', { error: err.message }));

  const alerts = new OpsAlertsService(
    buildEmailProvider(),
    new WorkerConfigService() as unknown as ConfigService,
  );

  const deps: DigestDeps = { prisma, redis, alerts, log: defaultLog };

  defaultLog('info', 'started', { interval_ms: WORKER_INTERVAL_MS, email_provider: EMAIL_PROVIDER_CONFIG });
  await redis.ping();
  await runDigestCycle(deps);

  setInterval(() => {
    runDigestCycle(deps).catch((err) =>
      defaultLog('error', 'unhandled_error', { error: String(err) }),
    );
  }, WORKER_INTERVAL_MS);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Worker failed to start:', err);
    process.exit(1);
  });
}
