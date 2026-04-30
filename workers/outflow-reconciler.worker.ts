/**
 * Outflow Reconciler Worker — standalone Node.js process (NOT NestJS).
 *
 * Backstop for lost provider webhooks. Periodically scans Outflows that have
 * stayed in PROCESSING longer than OUTFLOW_PROCESSING_STALE_SEC, asks the
 * underlying provider for ground-truth status via getTransferStatus, and
 * routes the answer through OutflowsService.handleSuccess /
 * OutflowsService.handleFailure — the same code paths the webhook controllers
 * use, so transitions stay identical regardless of which signal arrives first.
 *
 * Stub provider is hard-skipped: the stub backend never resolves async, so
 * polling it would burn cycles forever. Stub-stuck disbursements are recovered
 * via the ops "abandon attempt" endpoint instead.
 *
 * Run with: ts-node -r tsconfig-paths/register workers/outflow-reconciler.worker.ts
 */

import { PrismaClient, OutflowStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { REDIS_KEYS, OUTFLOW_PROCESSING_STALE_SEC } from '@/common/constants';
import { OutflowsService } from '@/modules/disbursements/outflows.service';
import { DisbursementsService } from '@/modules/disbursements/disbursements.service';
import { DisbursementRouter } from '@/modules/disbursements/disbursement-router.service';
import { OpsAlertsService } from '@/modules/ops-alerts/ops-alerts.service';
import { PalmpayProvider } from '@/providers/palmpay/palmpay.provider';
import { StubDisbursementProvider } from '@/providers/stub/stub-disbursement.provider';
import { MailgunProvider } from '@/providers/mailgun/mailgun.provider';
import { ResendProvider } from '@/providers/resend/resend.provider';
import { PostmarkProvider } from '@/providers/postmark/postmark.provider';
import type { EmailProvider } from '@/modules/auth/email.provider.interface';
import type { DisbursementProvider } from '@/modules/disbursements/disbursement.provider.interface';
import type { PrismaService } from '@/database/prisma.service';
import { EMAIL_PROVIDER_CONFIG, EmailProviderName } from '@/config/email.config';
import { DisbursementProviderName } from '@/config/disbursement.config';

const WORKER_INTERVAL_MS = parseInt(
  process.env.WORKER_OUTFLOW_RECONCILER_INTERVAL_MS ?? '60000',
  10,
);

const STUB_PROVIDER_NAME = DisbursementProviderName.Stub.toString();

export interface ReconcilerDeps {
  prisma:   PrismaClient;
  redis:    Redis;
  outflows: OutflowsService;
  // Provider lookup by name string — same string OutflowsService writes into
  // outflow.provider when the attempt is dispatched. The map is the worker's
  // local routing table; we don't go through DisbursementRouter here because
  // the chosen provider is already pinned per-attempt.
  providers: Map<string, DisbursementProvider>;
  log: (level: string, event: string, extra?: Record<string, unknown>) => void;
  now?: () => Date;
}

function defaultLog(level: string, event: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(
    JSON.stringify({ level, worker: 'outflow_reconciler', event, time: new Date().toISOString(), ...extra }) + '\n',
  );
}

type StaleOutflowRow = {
  outflow_id:         string;
  disbursement_id:    string;
  provider:           string;
  provider_reference: string;
};

export async function runReconcilerCycle(deps: ReconcilerDeps): Promise<void> {
  const { prisma, redis, outflows, providers, log } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - OUTFLOW_PROCESSING_STALE_SEC * 1000);

  // FOR UPDATE SKIP LOCKED keeps two concurrent reconciler instances from
  // racing on the same row — required by CLAUDE.md §12 for worker DB queries.
  const stale = await prisma.$queryRaw<StaleOutflowRow[]>`
    SELECT
      o.id              AS outflow_id,
      o.disbursement_id AS disbursement_id,
      o.provider        AS provider,
      o.provider_reference AS provider_reference
    FROM outflows o
    WHERE o.status = ${OutflowStatus.PROCESSING}::"outflow_status"
      AND o.initiated_at IS NOT NULL
      AND o.initiated_at < ${cutoff}
    ORDER BY o.initiated_at ASC
    FOR UPDATE SKIP LOCKED
  `;

  await redis.set(REDIS_KEYS.WORKER_HEARTBEAT('outflow_reconciler'), Date.now().toString());

  if (stale.length === 0) return;

  let reconciled_success = 0;
  let reconciled_failed  = 0;
  let still_processing   = 0;
  let skipped_stub       = 0;
  let errors             = 0;

  for (const row of stale) {
    try {
      // Stub never resolves naturally — its async transfer state is fictional.
      // Recovery for stub-stuck rows is the ops abandon-attempt endpoint.
      if (row.provider === STUB_PROVIDER_NAME) {
        skipped_stub++;
        log('debug', 'skipped_stub', { outflow_id: row.outflow_id });
        continue;
      }

      const impl = providers.get(row.provider);
      if (!impl) {
        log('error', 'unknown_provider', {
          outflow_id: row.outflow_id,
          provider:   row.provider,
        });
        errors++;
        continue;
      }

      log('debug', 'querying_provider', {
        outflow_id:         row.outflow_id,
        disbursement_id:    row.disbursement_id,
        provider:           row.provider,
        provider_reference: row.provider_reference,
      });

      const status = await impl.getTransferStatus(row.provider_reference);

      // Log the mapped result so a stuck row is auditable end-to-end:
      // PalmPay (queryPayStatus payload) → provider (mapped status) → reconciler.
      log('info', 'provider_status_resolved', {
        outflow_id:         row.outflow_id,
        disbursement_id:    row.disbursement_id,
        provider_reference: row.provider_reference,
        mapped_status:      status.status,
        failure_reason:     status.failure_reason,
        failure_code:       status.failure_code,
      });

      if (status.status === 'successful') {
        await outflows.handleSuccess(
          row.outflow_id,
          row.disbursement_id,
          row.provider_reference,
          { source: 'reconciler', verified_at: now.toISOString() },
        );
        reconciled_success++;
        log('info', 'reconciled_success', {
          outflow_id: row.outflow_id,
          disbursement_id: row.disbursement_id,
        });
      } else if (status.status === 'failed') {
        await outflows.handleFailure(
          row.outflow_id,
          row.disbursement_id,
          status.failure_reason ?? 'Provider reported failed via reconciler',
          status.failure_code,
        );
        reconciled_failed++;
        log('info', 'reconciled_failed', {
          outflow_id: row.outflow_id,
          disbursement_id: row.disbursement_id,
          failure_reason: status.failure_reason,
          failure_code:   status.failure_code,
        });
      } else {
        // Provider says still processing — leave the row alone, try again next tick.
        // Log per-row so a row stuck across many cycles is visible (used to be
        // silent — only the cycle-level still_processing counter showed it).
        still_processing++;
        log('info', 'still_processing', {
          outflow_id:         row.outflow_id,
          disbursement_id:    row.disbursement_id,
          provider_reference: row.provider_reference,
        });
      }
    } catch (err) {
      errors++;
      log('error', 'reconcile_failed', {
        outflow_id: row.outflow_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log('info', 'cycle_complete', {
    candidates:           stale.length,
    reconciled_success,
    reconciled_failed,
    still_processing,
    skipped_stub,
    errors,
  });
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────

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

// Construct the same disbursement-provider implementations the Nest app uses,
// directly with their config. Each provider is registered by name so the
// worker can route by the per-attempt `outflow.provider` snapshot.
function buildProviderMap(prisma: PrismaClient): Map<string, DisbursementProvider> {
  const palmpay = new PalmpayProvider({
    app_id:               process.env.PALMPAY_APP_ID                ?? '',
    merchant_id:          process.env.PALMPAY_MERCHANT_ID           ?? '',
    private_key:          process.env.PALMPAY_PRIVATE_KEY           ?? '',
    public_key:           process.env.PALMPAY_PUBLIC_KEY            ?? '',
    webhook_pub_key:      process.env.PALMPAY_WEBHOOK_PUB_KEY       ?? '',
    base_url:             process.env.PALMPAY_BASE_URL              ?? 'https://open-gw-prod.palmpay-inc.com',
    webhook_ip_allowlist: (process.env.PALMPAY_WEBHOOK_IP_ALLOWLIST ?? '')
      .split(',').map((s) => s.trim()).filter((s) => s.length > 0),
  });
  const stub = new StubDisbursementProvider(prisma as unknown as PrismaService);

  return new Map<string, DisbursementProvider>([
    [DisbursementProviderName.Palmpay, palmpay],
    [DisbursementProviderName.Stub,    stub],
  ]);
}

async function main(): Promise<void> {
  const DATABASE_URL = process.env.DATABASE_URL;
  const REDIS_URL    = process.env.REDIS_URL;
  if (!DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
  if (!REDIS_URL)    { console.error('REDIS_URL is required');    process.exit(1); }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });
  const redis  = new Redis(REDIS_URL);
  redis.on('error', (err) => defaultLog('error', 'redis_error', { error: err.message }));

  const providers   = buildProviderMap(prisma);

  // Reuse the production services so reconciler transitions match webhook
  // transitions exactly. PrismaClient is structurally compatible with
  // PrismaService (the latter extends the former); the ConfigService stub
  // only needs to surface `internal_alert_email`.
  const prisma_as_service = prisma as unknown as PrismaService;
  const router        = new DisbursementRouter(providers);
  const disbursements = new DisbursementsService(prisma_as_service);
  const opsAlerts     = new OpsAlertsService(buildEmailProvider(), new WorkerConfigService() as unknown as ConfigService);
  const outflows      = new OutflowsService(prisma_as_service, disbursements, router, opsAlerts);

  const deps: ReconcilerDeps = { prisma, redis, outflows, providers, log: defaultLog };

  defaultLog('info', 'started', {
    interval_ms: WORKER_INTERVAL_MS,
    stale_threshold_sec: OUTFLOW_PROCESSING_STALE_SEC,
  });
  await redis.ping();
  await runReconcilerCycle(deps);

  setInterval(() => {
    runReconcilerCycle(deps).catch((err) =>
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
