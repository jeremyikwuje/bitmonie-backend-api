import { runWebhookLogPruneCycle, type WebhookLogPruneDeps } from '../../../workers/webhook-log-prune.worker';
import { REDIS_KEYS } from '@/common/constants';

const NOW = new Date('2026-04-29T12:00:00Z');

function make_deps(retention_days: number, deleted_count: number) {
  const prisma = {
    webhookLog: { deleteMany: jest.fn().mockResolvedValue({ count: deleted_count }) },
  };
  const redis = {
    set: jest.fn().mockResolvedValue('OK'),
  };
  const log = jest.fn();

  const deps: WebhookLogPruneDeps = {
    prisma:         prisma as never,
    redis:          redis as never,
    log,
    retention_days,
    now:            () => NOW,
  };

  return { deps, prisma, redis, log };
}

describe('runWebhookLogPruneCycle', () => {
  it('deletes rows older than the cutoff (retention_days back from now)', async () => {
    const { deps, prisma } = make_deps(90, 0);

    await runWebhookLogPruneCycle(deps);

    expect(prisma.webhookLog.deleteMany).toHaveBeenCalledTimes(1);
    const arg = prisma.webhookLog.deleteMany.mock.calls[0][0] as {
      where: { received_at: { lt: Date } };
    };
    const cutoff = arg.where.received_at.lt;
    // 90 days before 2026-04-29T12:00:00Z = 2026-01-29T12:00:00Z
    expect(cutoff.toISOString()).toBe('2026-01-29T12:00:00.000Z');
  });

  it('updates the worker heartbeat in Redis even when nothing is deleted', async () => {
    const { deps, redis } = make_deps(90, 0);

    await runWebhookLogPruneCycle(deps);

    expect(redis.set).toHaveBeenCalledWith(
      REDIS_KEYS.WORKER_HEARTBEAT('webhook_log_prune'),
      expect.any(String),
    );
  });

  it('logs the deleted count + cutoff so cycles are auditable', async () => {
    const { deps, log } = make_deps(7, 42);

    await runWebhookLogPruneCycle(deps);

    expect(log).toHaveBeenCalledWith(
      'info',
      'cycle_complete',
      expect.objectContaining({
        deleted:        42,
        retention_days: 7,
        cutoff_iso:     expect.any(String),
      }),
    );
  });

  it('honours a custom retention_days override', async () => {
    const { deps, prisma } = make_deps(7, 0);

    await runWebhookLogPruneCycle(deps);

    const arg = prisma.webhookLog.deleteMany.mock.calls[0][0] as {
      where: { received_at: { lt: Date } };
    };
    // 7 days before 2026-04-29T12:00:00Z = 2026-04-22T12:00:00Z
    expect(arg.where.received_at.lt.toISOString()).toBe('2026-04-22T12:00:00.000Z');
  });
});
