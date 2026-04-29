/**
 * Webhook Log Prune Worker — runs inside the scheduler process.
 *
 * Deletes webhook_logs rows older than WEBHOOK_LOG_RETENTION_DAYS (default 90).
 * The table is bounded operational debug data, not financial state — pruning
 * is best-effort and idempotent. The query uses received_at, which is indexed.
 *
 * No transaction or row-level locking: deleting old rows can't conflict with
 * inserts (new rows have received_at = NOW(); the DELETE filters strictly
 * before that). Two scheduler instances running this concurrently is harmless
 * — the second pass simply finds nothing to delete.
 */

import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { WEBHOOK_LOG_RETENTION_DAYS, REDIS_KEYS } from '@/common/constants';

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

export interface WebhookLogPruneDeps {
  prisma: PrismaClient;
  redis:  Redis;
  log:    (level: string, event: string, extra?: Record<string, unknown>) => void;
  retention_days?: number;
  now?: () => Date;
}

export async function runWebhookLogPruneCycle(deps: WebhookLogPruneDeps): Promise<void> {
  const { prisma, redis, log } = deps;
  const retention_days = deps.retention_days ?? WEBHOOK_LOG_RETENTION_DAYS;
  const now    = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - retention_days * MS_PER_DAY);

  const result = await prisma.webhookLog.deleteMany({
    where: { received_at: { lt: cutoff } },
  });

  await redis.set(REDIS_KEYS.WORKER_HEARTBEAT('webhook_log_prune'), Date.now().toString());

  log('info', 'cycle_complete', {
    deleted:    result.count,
    cutoff_iso: cutoff.toISOString(),
    retention_days,
  });
}
