/**
 * Collateral Release Worker — standalone Node.js process (NOT NestJS).
 *
 * Safety net for the post-commit fire-and-forget release in
 * LoansService.creditInflow. Periodically scans loans where:
 *   status = REPAID
 *   collateral_released_at IS NULL
 *   collateral_release_address IS NOT NULL
 *
 * For each eligible loan, calls CollateralReleaseService.releaseForLoan —
 * the same code path the post-commit hand-off and the ops endpoint use.
 * Concurrency between the three is coordinated by a per-loan Redis SETNX
 * lock inside the service, so a loan that's currently being processed
 * elsewhere is skipped cleanly (status=in_flight return, no error).
 *
 * On send failure: the service emits an ops alert (rate-limited to one
 * per 24h per loan via Redis dedupe), and the worker just keeps trying on
 * each tick. When the customer (or ops) updates the release address via
 * PATCH /v1/loans/:id/release-address or POST /v1/ops/loans/:id/release-collateral,
 * the dedupe key is cleared so the next failure pages ops fresh.
 *
 * Run with: ts-node -r tsconfig-paths/register workers/collateral-release.worker.ts
 */

import { PrismaClient, LoanStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { REDIS_KEYS } from '@/common/constants';
import { CollateralReleaseService } from '@/modules/loans/collateral-release.service';
import { LoanStatusService } from '@/modules/loans/loan-status.service';
import { OpsAlertsService } from '@/modules/ops-alerts/ops-alerts.service';
import { BlinkProvider } from '@/providers/blink/blink.provider';
import { MailgunProvider } from '@/providers/mailgun/mailgun.provider';
import { ResendProvider } from '@/providers/resend/resend.provider';
import { PostmarkProvider } from '@/providers/postmark/postmark.provider';
import type { EmailProvider } from '@/modules/auth/email.provider.interface';
import type { PrismaService } from '@/database/prisma.service';
import { EMAIL_PROVIDER_CONFIG, EmailProviderName } from '@/config/email.config';

const WORKER_INTERVAL_MS = parseInt(
  process.env.WORKER_COLLATERAL_RELEASE_INTERVAL_MS ?? '300000',  // 5 min default
  10,
);

// Cap how many loans a single tick processes. Prevents a one-time backlog
// (e.g. provider was down for hours) from holding the Redis lock + DB
// connection for the full set in one cycle. The next tick picks up the rest.
const MAX_LOANS_PER_CYCLE = 50;

export interface CollateralReleaseWorkerDeps {
  prisma:             PrismaClient;
  redis:              Redis;
  collateral_release: CollateralReleaseService;
  log: (level: string, event: string, extra?: Record<string, unknown>) => void;
  now?: () => Date;
}

function defaultLog(level: string, event: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(
    JSON.stringify({ level, worker: 'collateral_release', event, time: new Date().toISOString(), ...extra }) + '\n',
  );
}

type EligibleRow = {
  id:                          string;
  user_id:                     string;
  collateral_amount_sat:       bigint;
  collateral_release_address:  string | null;
};

export async function runCollateralReleaseCycle(deps: CollateralReleaseWorkerDeps): Promise<void> {
  const { prisma, redis, collateral_release, log } = deps;

  // FOR UPDATE SKIP LOCKED so concurrent reconciler instances don't both
  // claim the same loan rows — required by CLAUDE.md §12.
  const eligible = await prisma.$queryRaw<EligibleRow[]>`
    SELECT id, user_id, collateral_amount_sat, collateral_release_address
      FROM loans
     WHERE status = ${LoanStatus.REPAID}::"loan_status"
       AND collateral_released_at IS NULL
       AND collateral_release_address IS NOT NULL
     ORDER BY repaid_at ASC NULLS FIRST
     LIMIT ${MAX_LOANS_PER_CYCLE}
       FOR UPDATE SKIP LOCKED
  `;

  await redis.set(REDIS_KEYS.WORKER_HEARTBEAT('collateral_release'), Date.now().toString());

  if (eligible.length === 0) return;

  let released         = 0;
  let already_released = 0;
  let in_flight        = 0;
  let send_failed      = 0;
  let not_eligible     = 0;
  let errors           = 0;

  for (const row of eligible) {
    try {
      const result = await collateral_release.releaseForLoan(row.id);

      switch (result.status) {
        case 'released':
          released++;
          log('info', 'released', {
            loan_id:    row.id,
            user_id:    row.user_id,
            amount_sat: row.collateral_amount_sat.toString(),
            reference:  result.reference,
          });
          break;
        case 'already_released':
          already_released++;
          log('debug', 'already_released', { loan_id: row.id, reference: result.reference });
          break;
        case 'in_flight':
          in_flight++;
          log('debug', 'in_flight', { loan_id: row.id });
          break;
        case 'not_eligible':
          not_eligible++;
          // Loan was eligible at SELECT-time but the service rejected — most
          // commonly because the post-commit hand-off raced ahead and stamped
          // it between our SELECT and the lock acquire. Logged at info so
          // it's visible but not noisy.
          log('info', 'not_eligible', { loan_id: row.id, reason: result.reason });
          break;
        case 'send_failed':
          send_failed++;
          // Provider rejected the send. Service has already alerted ops
          // (rate-limited via Redis dedupe). Worker will retry next tick;
          // if the cause is a bad customer address, alert recurs once per
          // 24h until the address is fixed.
          log('warn', 'send_failed', { loan_id: row.id, error: result.error });
          break;
      }
    } catch (err) {
      errors++;
      log('error', 'release_threw', {
        loan_id: row.id,
        error:   err instanceof Error ? err.message : String(err),
      });
    }
  }

  log('info', 'cycle_complete', {
    eligible_count: eligible.length,
    released,
    already_released,
    in_flight,
    send_failed,
    not_eligible,
    errors,
  });
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

async function main(): Promise<void> {
  const DATABASE_URL = process.env.DATABASE_URL;
  const REDIS_URL    = process.env.REDIS_URL;
  if (!DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
  if (!REDIS_URL)    { console.error('REDIS_URL is required');    process.exit(1); }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });
  const redis  = new Redis(REDIS_URL);
  redis.on('error', (err) => defaultLog('error', 'redis_error', { error: err.message }));

  // The same Blink provider the API uses. Cast PrismaClient → PrismaService
  // is safe (the latter just extends the former).
  const blink = new BlinkProvider({
    api_key:        process.env.BLINK_API_KEY        ?? '',
    base_url:       process.env.BLINK_BASE_URL        ?? 'https://api.blink.sv',
    wallet_btc_id:  process.env.BLINK_WALLET_BTC_ID   ?? '',
    wallet_usd_id:  process.env.BLINK_WALLET_USD_ID   ?? '',
    account_id:     process.env.BLINK_ACCOUNT_ID      ?? '',
    webhook_secret: process.env.BLINK_WEBHOOK_SECRET  ?? '',
  });

  const prisma_as_service = prisma as unknown as PrismaService;
  const email_provider    = buildEmailProvider();
  const ops_alerts        = new OpsAlertsService(email_provider, new WorkerConfigService() as unknown as ConfigService);
  const loan_status       = new LoanStatusService();
  const collateral_release = new CollateralReleaseService(
    prisma_as_service,
    blink,
    loan_status,
    ops_alerts,
    redis,
  );

  const deps: CollateralReleaseWorkerDeps = { prisma, redis, collateral_release, log: defaultLog };

  defaultLog('info', 'started', { interval_ms: WORKER_INTERVAL_MS });
  await redis.ping();
  await runCollateralReleaseCycle(deps);

  setInterval(() => {
    runCollateralReleaseCycle(deps).catch((err) =>
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
