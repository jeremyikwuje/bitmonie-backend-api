import { runLiquidationCycle, type LiquidationDeps } from '../../../workers/liquidation-monitor.worker';
import { LoanStatus, StatusTrigger } from '@prisma/client';
import { REDIS_KEYS, LoanReasonCodes } from '@/common/constants';

const LOAN_ID   = 'loan-uuid-001';
const USER_ID   = 'user-uuid-001';

function makeLoan(overrides: Partial<{
  id: string;
  user_id: string;
  collateral_amount_sat: bigint;
  principal_ngn: string;
  collateral_release_address: string | null;
}> = {}) {
  return {
    id:                         LOAN_ID,
    user_id:                    USER_ID,
    collateral_amount_sat:      BigInt(1_000_000),   // 0.01 BTC
    principal_ngn:              '80000',             // N80,000
    collateral_release_address: null,
    ...overrides,
  };
}

type MockTx = {
  loan:          { update: jest.Mock };
  loanStatusLog: { create: jest.Mock };
};

function makeDeps(
  loans: ReturnType<typeof makeLoan>[] = [],
  redis_overrides: Record<string, string | null> = {},
): LiquidationDeps & { prisma: jest.Mocked<LiquidationDeps['prisma']>; redis: jest.Mocked<LiquidationDeps['redis']>; log: jest.Mock; blink: { swapBtcToUsd: jest.Mock } } {
  const redis_store: Record<string, string | null> = {
    [REDIS_KEYS.PRICE_STALE]:        null,
    [REDIS_KEYS.PRICE('SAT_NGN')]:   JSON.stringify({ buy: '100.000000', sell: '100.000000' }),
    ...redis_overrides,
  };

  const mock_tx: MockTx = {
    loan:          { update: jest.fn().mockResolvedValue({}) },
    loanStatusLog: { create: jest.fn().mockResolvedValue({}) },
  };

  const prisma = {
    $queryRaw:   jest.fn().mockResolvedValue(loans),
    $transaction: jest.fn().mockImplementation((fn: (tx: typeof mock_tx) => Promise<unknown>) => fn(mock_tx)),
    _mock_tx:    mock_tx,
  } as unknown as jest.Mocked<LiquidationDeps['prisma']>;

  const redis = {
    get: jest.fn().mockImplementation((key: string) =>
      Promise.resolve(redis_store[key] ?? null),
    ),
    set: jest.fn().mockResolvedValue('OK'),
  } as unknown as jest.Mocked<LiquidationDeps['redis']>;

  const log   = jest.fn();
  const blink = { swapBtcToUsd: jest.fn().mockResolvedValue(undefined) };

  return { prisma, redis, log, blink } as unknown as LiquidationDeps & {
    prisma: jest.Mocked<LiquidationDeps['prisma']>;
    redis: jest.Mocked<LiquidationDeps['redis']>;
    log: jest.Mock;
    blink: { swapBtcToUsd: jest.Mock };
  };
}

describe('runLiquidationCycle', () => {
  it('skips all liquidations when price:stale is set', async () => {
    const deps = makeDeps([], { [REDIS_KEYS.PRICE_STALE]: 'stale_ts' });

    await runLiquidationCycle(deps);

    expect(deps.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith('warn', 'price_stale_skip', expect.any(Object));
    expect(deps.redis.set).toHaveBeenCalledWith(
      REDIS_KEYS.WORKER_HEARTBEAT('liquidation_monitor'),
      expect.any(String),
    );
  });

  it('skips when SAT_NGN rate is not in Redis', async () => {
    const deps = makeDeps([], { [REDIS_KEYS.PRICE('SAT_NGN')]: null });

    await runLiquidationCycle(deps);

    expect(deps.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith('warn', 'no_rate', expect.any(Object));
  });

  it('liquidates a loan when ratio <= 1.10', async () => {
    // collateral = 100_000 sat * 0.80 NGN/sat = 80_000 NGN
    // principal  = 80_000 NGN; ratio = 1.0 → below LIQUIDATION_THRESHOLD (1.10)
    const loan = makeLoan({ collateral_amount_sat: BigInt(100_000), principal_ngn: '80000' });
    const deps = makeDeps([loan], {
      [REDIS_KEYS.PRICE('SAT_NGN')]: JSON.stringify({ buy: '0.900000', sell: '0.800000' }),
    });

    await runLiquidationCycle(deps);

    expect(deps.prisma.$transaction).toHaveBeenCalled();
    const mock_tx = (deps.prisma as unknown as { _mock_tx: MockTx })._mock_tx;
    expect(mock_tx.loan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: LOAN_ID },
        data:  expect.objectContaining({ status: LoanStatus.LIQUIDATED }),
      }),
    );
    expect(mock_tx.loanStatusLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          loan_id:      LOAN_ID,
          from_status:  LoanStatus.ACTIVE,
          to_status:    LoanStatus.LIQUIDATED,
          triggered_by: StatusTrigger.SYSTEM,
          reason_code:  LoanReasonCodes.LIQUIDATION_COMPLETED,
        }),
      }),
    );
    expect(deps.log).toHaveBeenCalledWith('warn', 'loan_liquidated', expect.objectContaining({ loan_id: LOAN_ID }));
    expect(deps.blink.swapBtcToUsd).toHaveBeenCalledWith(BigInt(100_000));
  });

  it('logs error but does not fail liquidation when BTC swap fails', async () => {
    const loan = makeLoan({ collateral_amount_sat: BigInt(100_000), principal_ngn: '80000' });
    const deps = makeDeps([loan], {
      [REDIS_KEYS.PRICE('SAT_NGN')]: JSON.stringify({ buy: '0.900000', sell: '0.800000' }),
    });
    deps.blink.swapBtcToUsd.mockRejectedValue(new Error('Blink API timeout'));

    await runLiquidationCycle(deps);

    expect(deps.prisma.$transaction).toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith('error', 'btc_swap_failed', expect.objectContaining({ loan_id: LOAN_ID }));
  });

  it('sends alert when ratio <= 1.20 and no alert already sent', async () => {
    // collateral = 100_000 sat * 0.90 NGN/sat = 90_000 NGN
    // principal  = 80_000 NGN; ratio = 90_000 / 80_000 = 1.125 → between 1.10 and 1.20
    const loan = makeLoan({ collateral_amount_sat: BigInt(100_000), principal_ngn: '80000' });
    const deps = makeDeps([loan], {
      [REDIS_KEYS.PRICE('SAT_NGN')]: JSON.stringify({ buy: '1.000000', sell: '0.900000' }),
      [REDIS_KEYS.ALERT_SENT(LOAN_ID)]: null,
    });

    await runLiquidationCycle(deps);

    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
    expect(deps.redis.set).toHaveBeenCalledWith(
      REDIS_KEYS.ALERT_SENT(LOAN_ID),
      '1',
      'EX',
      86_400,
    );
    expect(deps.log).toHaveBeenCalledWith('warn', 'liquidation_alert', expect.objectContaining({ loan_id: LOAN_ID }));
  });

  it('does not re-alert within the 24h cooldown window', async () => {
    const loan = makeLoan({ collateral_amount_sat: BigInt(100_000), principal_ngn: '80000' });
    const deps = makeDeps([loan], {
      [REDIS_KEYS.PRICE('SAT_NGN')]: JSON.stringify({ buy: '1.000000', sell: '0.900000' }),
      [REDIS_KEYS.ALERT_SENT(LOAN_ID)]: '1',
    });

    await runLiquidationCycle(deps);

    const set_calls = (deps.redis.set as jest.Mock).mock.calls.filter(
      (call: unknown[]) => call[0] === REDIS_KEYS.ALERT_SENT(LOAN_ID),
    );
    expect(set_calls).toHaveLength(0);
    const alert_logs = (deps.log as jest.Mock).mock.calls.filter(
      (call: unknown[]) => call[1] === 'liquidation_alert',
    );
    expect(alert_logs).toHaveLength(0);
  });

  it('does nothing for a healthy loan (ratio > 1.20)', async () => {
    // collateral = 100_000 sat * 1.50 NGN/sat = 150_000 NGN
    // principal  = 80_000 NGN; ratio = 1.875 → healthy (> 1.20)
    const loan = makeLoan({ collateral_amount_sat: BigInt(100_000), principal_ngn: '80000' });
    const deps = makeDeps([loan], {
      [REDIS_KEYS.PRICE('SAT_NGN')]: JSON.stringify({ buy: '1.600000', sell: '1.500000' }),
    });

    await runLiquidationCycle(deps);

    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
    const alert_logs = (deps.log as jest.Mock).mock.calls.filter(
      (call: unknown[]) => call[1] === 'liquidation_alert',
    );
    expect(alert_logs).toHaveLength(0);
  });

  it('posts heartbeat on successful completion', async () => {
    const deps = makeDeps([]);

    await runLiquidationCycle(deps);

    expect(deps.redis.set).toHaveBeenCalledWith(
      REDIS_KEYS.WORKER_HEARTBEAT('liquidation_monitor'),
      expect.any(String),
    );
  });

  it('continues processing remaining loans if one liquidation fails', async () => {
    const loan1 = makeLoan({ id: 'loan-001', collateral_amount_sat: BigInt(100_000), principal_ngn: '80000' });
    const loan2 = makeLoan({ id: 'loan-002', collateral_amount_sat: BigInt(100_000), principal_ngn: '80000' });
    const deps = makeDeps([loan1, loan2], {
      [REDIS_KEYS.PRICE('SAT_NGN')]: JSON.stringify({ buy: '0.900000', sell: '0.800000' }),
    });

    let call_count = 0;
    (deps.prisma.$transaction as jest.Mock).mockImplementation((fn: (tx: MockTx) => Promise<unknown>) => {
      call_count++;
      if (call_count === 1) throw new Error('DB error');
      const tx: MockTx = {
        loan:          { update: jest.fn().mockResolvedValue({}) },
        loanStatusLog: { create: jest.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });

    await runLiquidationCycle(deps);

    expect(deps.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(deps.log).toHaveBeenCalledWith('error', 'liquidation_failed', expect.objectContaining({ loan_id: 'loan-001' }));
  });
});
