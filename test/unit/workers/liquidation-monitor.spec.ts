import { runLiquidationCycle, type LiquidationDeps } from '../../../workers/liquidation-monitor.worker';
import { LoanStatus, StatusTrigger } from '@prisma/client';
import { REDIS_KEYS, LoanReasonCodes } from '@/common/constants';
import { AccrualService } from '@/modules/loans/accrual.service';

const LOAN_ID   = 'loan-uuid-001';
const USER_ID   = 'user-uuid-001';

function makeLoan(overrides: Partial<{
  id: string;
  user_id: string;
  collateral_amount_sat: bigint;
  principal_ngn: string;
  daily_interest_rate_bps: number;
  daily_custody_fee_ngn: string;
  collateral_received_at: Date | null;
  sat_ngn_rate_at_creation: string;
  collateral_release_address: string | null;
}> = {}) {
  return {
    id:                         LOAN_ID,
    user_id:                    USER_ID,
    collateral_amount_sat:      BigInt(1_000_000),                 // 0.01 BTC
    principal_ngn:              '80000',                           // N80,000
    daily_interest_rate_bps:    30,
    daily_custody_fee_ngn:      '100',
    collateral_received_at:     new Date(Date.now() - 1_000),      // ~1s ago — day 1 accrual
    sat_ngn_rate_at_creation:   '1.000000',                        // baseline for sanity-bound checks
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
  repayments: Array<{
    loan_id: string;
    applied_to_principal: string;
    applied_to_interest:  string;
    applied_to_custody:   string;
    created_at:           Date;
  }> = [],
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
    $queryRaw:    jest.fn().mockResolvedValue(loans),
    $transaction: jest.fn().mockImplementation((fn: (tx: typeof mock_tx) => Promise<unknown>) => fn(mock_tx)),
    loanRepayment: { findMany: jest.fn().mockResolvedValue(repayments) },
    _mock_tx:     mock_tx,
  } as unknown as jest.Mocked<LiquidationDeps['prisma']>;

  const redis = {
    get: jest.fn().mockImplementation((key: string) =>
      Promise.resolve(redis_store[key] ?? null),
    ),
    set: jest.fn().mockResolvedValue('OK'),
  } as unknown as jest.Mocked<LiquidationDeps['redis']>;

  const log     = jest.fn();
  const blink   = { swapBtcToUsd: jest.fn().mockResolvedValue(undefined) };
  const accrual = new AccrualService();

  return { prisma, redis, log, blink, accrual } as unknown as LiquidationDeps & {
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

  it('aborts cycle and marks price stale when rate is zero', async () => {
    const loan = makeLoan({ collateral_amount_sat: BigInt(100_000), principal_ngn: '80000' });
    const deps = makeDeps([loan], {
      [REDIS_KEYS.PRICE('SAT_NGN')]: JSON.stringify({ buy: '0', sell: '0' }),
    });

    await runLiquidationCycle(deps);

    expect(deps.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith('error', 'rate_non_positive_abort', expect.any(Object));
    expect(deps.redis.set).toHaveBeenCalledWith(REDIS_KEYS.PRICE_STALE, expect.any(String));
  });

  it('aborts cycle when rate is negative', async () => {
    const deps = makeDeps([], {
      [REDIS_KEYS.PRICE('SAT_NGN')]: JSON.stringify({ buy: '-1', sell: '-1' }),
    });

    await runLiquidationCycle(deps);

    expect(deps.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith('error', 'rate_non_positive_abort', expect.any(Object));
    expect(deps.redis.set).toHaveBeenCalledWith(REDIS_KEYS.PRICE_STALE, expect.any(String));
  });

  it('skips liquidation and pages ops when current rate is below sanity floor', async () => {
    // sat_ngn_rate_at_creation = 1.000000; floor = 1.0 × 0.5 = 0.5
    // current rate = 0.4 (below floor) → would have liquidated, but skipped instead
    const loan = makeLoan({
      collateral_amount_sat:    BigInt(100_000),
      principal_ngn:            '80000',
      sat_ngn_rate_at_creation: '1.000000',
    });
    const deps = makeDeps([loan], {
      [REDIS_KEYS.PRICE('SAT_NGN')]: JSON.stringify({ buy: '0.500000', sell: '0.400000' }),
    });

    await runLiquidationCycle(deps);

    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(
      'error',
      'liquidation_skipped_rate_suspect',
      expect.objectContaining({ loan_id: LOAN_ID, current_rate: '0.400000' }),
    );
    expect(deps.blink.swapBtcToUsd).not.toHaveBeenCalled();
  });

  it('liquidates when collateral covers principal but not outstanding (accrual-aware ratio)', async () => {
    // 60-day-old loan at 0.3% daily + N100/day custody.
    // outstanding = 80_000 + 80_000 × 0.003 × 60 + 100 × 60 = 100_400 NGN
    // collateral  = 100_000 sat × 0.95 = 95_000 NGN
    // ratio_principal   = 95_000 / 80_000  = 1.1875  → old behaviour: only alerts
    // ratio_outstanding = 95_000 / 100_400 = 0.9462  → new behaviour: liquidates
    const sixty_days_ago = new Date(Date.now() - 60 * 86_400_000);
    const loan = makeLoan({
      collateral_amount_sat:  BigInt(100_000),
      principal_ngn:          '80000',
      collateral_received_at: sixty_days_ago,
    });
    const deps = makeDeps([loan], {
      [REDIS_KEYS.PRICE('SAT_NGN')]: JSON.stringify({ buy: '1.000000', sell: '0.950000' }),
    });

    await runLiquidationCycle(deps);

    expect(deps.prisma.$transaction).toHaveBeenCalled();
    const mock_tx = (deps.prisma as unknown as { _mock_tx: MockTx })._mock_tx;
    expect(mock_tx.loan.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: LoanStatus.LIQUIDATED }) }),
    );
  });

  it('reduces outstanding by repayments when computing ratio', async () => {
    // 60-day-old loan, customer paid back N50_000 30 days ago — waterfall took
    // custody (3000) + interest (~7200) + ~39_800 of principal. From day 30 on,
    // interest accrues at the lower principal. With repayment, outstanding ends
    // up healthy enough that ratio > 1.10 (no liquidation).
    const sixty_days_ago = new Date(Date.now() - 60 * 86_400_000);
    const thirty_days_ago = new Date(Date.now() - 30 * 86_400_000);
    const loan = makeLoan({
      collateral_amount_sat:  BigInt(100_000),
      principal_ngn:          '80000',
      collateral_received_at: sixty_days_ago,
    });
    const deps = makeDeps(
      [loan],
      { [REDIS_KEYS.PRICE('SAT_NGN')]: JSON.stringify({ buy: '1.000000', sell: '0.950000' }) },
      [{
        loan_id:              LOAN_ID,
        applied_to_principal: '39800',
        applied_to_interest:  '7200',
        applied_to_custody:   '3000',
        created_at:           thirty_days_ago,
      }],
    );

    await runLiquidationCycle(deps);

    // outstanding ≈ (80000 - 39800) + interest_after_repayment + (60×100 - 3000)
    //             = 40_200 + ~3618 + 3000 ≈ 46_818
    // collateral  = 95_000; ratio ≈ 2.029 → healthy, no action
    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
    const alert_logs = (deps.log as jest.Mock).mock.calls.filter(
      (call: unknown[]) => call[1] === 'liquidation_alert',
    );
    expect(alert_logs).toHaveLength(0);
  });

  it('still liquidates when current rate is at or above the sanity floor', async () => {
    // sat_ngn_rate_at_creation = 1.000000; floor = 0.5; current rate = 0.6 → above floor
    // collateral 100_000 sat × 0.6 = 60_000 NGN; principal 80_000; ratio = 0.75 ≤ 1.10
    const loan = makeLoan({
      collateral_amount_sat:    BigInt(100_000),
      principal_ngn:            '80000',
      sat_ngn_rate_at_creation: '1.000000',
    });
    const deps = makeDeps([loan], {
      [REDIS_KEYS.PRICE('SAT_NGN')]: JSON.stringify({ buy: '0.700000', sell: '0.600000' }),
    });

    await runLiquidationCycle(deps);

    expect(deps.prisma.$transaction).toHaveBeenCalled();
    const mock_tx = (deps.prisma as unknown as { _mock_tx: MockTx })._mock_tx;
    expect(mock_tx.loan.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: LoanStatus.LIQUIDATED }) }),
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
