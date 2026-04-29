import { runReconcilerCycle, type ReconcilerDeps } from '../../../workers/outflow-reconciler.worker';
import { OutflowsService } from '@/modules/disbursements/outflows.service';
import type { DisbursementProvider } from '@/modules/disbursements/disbursement.provider.interface';
import { REDIS_KEYS, OUTFLOW_PROCESSING_STALE_SEC } from '@/common/constants';
import { DisbursementProviderName } from '@/config/disbursement.config';

const OUTFLOW_ID      = 'outflow-uuid-001';
const DISBURSEMENT_ID = 'disb-uuid-001';
const PROVIDER_REF    = `outflow-1-${DISBURSEMENT_ID}`;
const NOW             = new Date('2026-04-28T16:00:00Z');

function staleOutflow(overrides: Partial<{
  outflow_id:         string;
  disbursement_id:    string;
  provider:           string;
  provider_reference: string;
}> = {}) {
  return {
    outflow_id:         OUTFLOW_ID,
    disbursement_id:    DISBURSEMENT_ID,
    provider:           DisbursementProviderName.Palmpay.toString(),
    provider_reference: PROVIDER_REF,
    ...overrides,
  };
}

function makeDeps(rows: ReturnType<typeof staleOutflow>[]): ReconcilerDeps & {
  outflows: jest.Mocked<Pick<OutflowsService, 'handleSuccess' | 'handleFailure'>>;
  palmpay:  jest.Mocked<Pick<DisbursementProvider, 'getTransferStatus'>>;
  log:      jest.Mock;
} {
  const palmpay = {
    getTransferStatus: jest.fn(),
  } as unknown as jest.Mocked<Pick<DisbursementProvider, 'getTransferStatus'>>;

  const outflows = {
    handleSuccess: jest.fn().mockResolvedValue(undefined),
    handleFailure: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<Pick<OutflowsService, 'handleSuccess' | 'handleFailure'>>;

  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue(rows),
  };
  const redis = { set: jest.fn().mockResolvedValue('OK') };
  const log   = jest.fn();

  const providers = new Map<string, DisbursementProvider>([
    [DisbursementProviderName.Palmpay, palmpay as unknown as DisbursementProvider],
  ]);

  return {
    prisma:    prisma as never,
    redis:     redis as never,
    outflows:  outflows as unknown as OutflowsService,
    providers,
    log,
    now:       () => NOW,
    // expose strongly-typed handles for assertions
    palmpay:   palmpay as never,
  } as unknown as ReconcilerDeps & {
    outflows: jest.Mocked<Pick<OutflowsService, 'handleSuccess' | 'handleFailure'>>;
    palmpay:  jest.Mocked<Pick<DisbursementProvider, 'getTransferStatus'>>;
    log:      jest.Mock;
  };
}

describe('runReconcilerCycle', () => {
  it('updates the heartbeat and returns early when no stale outflows are found', async () => {
    const deps = makeDeps([]);

    await runReconcilerCycle(deps);

    expect(deps.outflows.handleSuccess).not.toHaveBeenCalled();
    expect(deps.outflows.handleFailure).not.toHaveBeenCalled();
    expect(deps.redis.set).toHaveBeenCalledWith(
      REDIS_KEYS.WORKER_HEARTBEAT('outflow_reconciler'),
      expect.any(String),
    );
  });

  it('queries for outflows older than OUTFLOW_PROCESSING_STALE_SEC ago', async () => {
    const deps = makeDeps([]);

    await runReconcilerCycle(deps);

    // The query is interpolated into a tagged template — check that the cutoff
    // parameter handed in is exactly stale-seconds before the injected `now`.
    const call_args = (deps.prisma.$queryRaw as unknown as jest.Mock).mock.calls[0];
    const cutoff_arg = call_args.find((a: unknown) => a instanceof Date) as Date;
    expect(cutoff_arg).toBeInstanceOf(Date);
    expect(NOW.getTime() - cutoff_arg.getTime()).toBe(OUTFLOW_PROCESSING_STALE_SEC * 1000);
  });

  it('routes provider "successful" → OutflowsService.handleSuccess', async () => {
    const deps = makeDeps([staleOutflow()]);
    deps.palmpay.getTransferStatus.mockResolvedValue({ status: 'successful' });

    await runReconcilerCycle(deps);

    expect(deps.palmpay.getTransferStatus).toHaveBeenCalledWith(PROVIDER_REF);
    expect(deps.outflows.handleSuccess).toHaveBeenCalledWith(
      OUTFLOW_ID,
      DISBURSEMENT_ID,
      PROVIDER_REF,
      expect.objectContaining({ source: 'reconciler' }),
    );
    expect(deps.outflows.handleFailure).not.toHaveBeenCalled();
  });

  it('routes provider "failed" → OutflowsService.handleFailure (passes failure_reason + failure_code)', async () => {
    const deps = makeDeps([staleOutflow()]);
    deps.palmpay.getTransferStatus.mockResolvedValue({
      status:         'failed',
      failure_reason: 'Bank declined',
      failure_code:   'BANK_DECLINED',
    });

    await runReconcilerCycle(deps);

    expect(deps.outflows.handleFailure).toHaveBeenCalledWith(
      OUTFLOW_ID,
      DISBURSEMENT_ID,
      'Bank declined',
      'BANK_DECLINED',
    );
    expect(deps.outflows.handleSuccess).not.toHaveBeenCalled();
  });

  it('leaves outflows alone when provider says still "processing"', async () => {
    const deps = makeDeps([staleOutflow()]);
    deps.palmpay.getTransferStatus.mockResolvedValue({ status: 'processing' });

    await runReconcilerCycle(deps);

    expect(deps.outflows.handleSuccess).not.toHaveBeenCalled();
    expect(deps.outflows.handleFailure).not.toHaveBeenCalled();
  });

  it('hard-skips the stub provider — never calls getTransferStatus or transitions', async () => {
    const deps = makeDeps([staleOutflow({ provider: DisbursementProviderName.Stub.toString() })]);

    await runReconcilerCycle(deps);

    expect(deps.palmpay.getTransferStatus).not.toHaveBeenCalled();
    expect(deps.outflows.handleSuccess).not.toHaveBeenCalled();
    expect(deps.outflows.handleFailure).not.toHaveBeenCalled();
  });

  it('logs and continues when an unknown provider name is encountered', async () => {
    const deps = makeDeps([
      staleOutflow({ outflow_id: 'unknown-1', provider: 'unregistered_provider' }),
      staleOutflow({ outflow_id: 'palmpay-1' }),
    ]);
    deps.palmpay.getTransferStatus.mockResolvedValue({ status: 'successful' });

    await runReconcilerCycle(deps);

    // Unknown provider logs error but doesn't throw — second row still processed
    expect(deps.log).toHaveBeenCalledWith(
      'error',
      'unknown_provider',
      expect.objectContaining({ outflow_id: 'unknown-1' }),
    );
    expect(deps.outflows.handleSuccess).toHaveBeenCalledWith(
      'palmpay-1',
      DISBURSEMENT_ID,
      PROVIDER_REF,
      expect.any(Object),
    );
  });

  it('catches per-row errors so one bad outflow does not block the rest of the batch', async () => {
    const deps = makeDeps([
      staleOutflow({ outflow_id: 'throws-1' }),
      staleOutflow({ outflow_id: 'ok-1' }),
    ]);
    deps.palmpay.getTransferStatus
      .mockRejectedValueOnce(new Error('Provider 503'))
      .mockResolvedValueOnce({ status: 'successful' });

    await runReconcilerCycle(deps);

    expect(deps.log).toHaveBeenCalledWith(
      'error',
      'reconcile_failed',
      expect.objectContaining({ outflow_id: 'throws-1' }),
    );
    expect(deps.outflows.handleSuccess).toHaveBeenCalledWith(
      'ok-1',
      DISBURSEMENT_ID,
      PROVIDER_REF,
      expect.any(Object),
    );
  });
});
