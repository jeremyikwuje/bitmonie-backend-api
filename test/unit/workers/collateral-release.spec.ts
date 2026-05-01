import {
  runCollateralReleaseCycle,
  type CollateralReleaseWorkerDeps,
} from '../../../workers/collateral-release.worker';
import type { CollateralReleaseService, ReleaseResult } from '@/modules/loans/collateral-release.service';
import { REDIS_KEYS } from '@/common/constants';

const LOAN_A = 'loan-uuid-A';
const LOAN_B = 'loan-uuid-B';
const USER   = 'user-uuid-001';

function eligibleRow(loan_id: string) {
  return {
    id:                          loan_id,
    user_id:                     USER,
    collateral_amount_sat:       BigInt(515464),
    collateral_release_address:  'ada@blink.sv',
  };
}

function makeDeps(rows: ReturnType<typeof eligibleRow>[]): CollateralReleaseWorkerDeps & {
  release: jest.Mocked<Pick<CollateralReleaseService, 'releaseForLoan'>>;
  log:     jest.Mock;
} {
  const release = {
    releaseForLoan: jest.fn(),
  } as unknown as jest.Mocked<Pick<CollateralReleaseService, 'releaseForLoan'>>;

  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue(rows),
  };
  const redis = { set: jest.fn().mockResolvedValue('OK') };
  const log   = jest.fn();

  return {
    prisma:             prisma as never,
    redis:              redis as never,
    collateral_release: release as unknown as CollateralReleaseService,
    release,
    log,
  };
}

function ok(reference = 'blink:ln_address:ada@blink.sv:515464:0'): ReleaseResult {
  return { status: 'released', reference };
}

describe('runCollateralReleaseCycle', () => {
  it('writes a heartbeat on every tick (even when no eligible loans)', async () => {
    const deps = makeDeps([]);
    await runCollateralReleaseCycle(deps);
    const redis = deps.redis as unknown as { set: jest.Mock };
    expect(redis.set).toHaveBeenCalledWith(
      REDIS_KEYS.WORKER_HEARTBEAT('collateral_release'),
      expect.any(String),
    );
  });

  it('calls releaseForLoan for every eligible row', async () => {
    const deps = makeDeps([eligibleRow(LOAN_A), eligibleRow(LOAN_B)]);
    deps.release.releaseForLoan.mockResolvedValue(ok());
    await runCollateralReleaseCycle(deps);
    expect(deps.release.releaseForLoan).toHaveBeenCalledTimes(2);
    expect(deps.release.releaseForLoan).toHaveBeenCalledWith(LOAN_A);
    expect(deps.release.releaseForLoan).toHaveBeenCalledWith(LOAN_B);
  });

  it('returns early without invoking the release service when there are no eligible loans', async () => {
    const deps = makeDeps([]);
    await runCollateralReleaseCycle(deps);
    expect(deps.release.releaseForLoan).not.toHaveBeenCalled();
  });

  it('SQL filter restricts to status=REPAID + released_at IS NULL + address IS NOT NULL', async () => {
    // The worker pulls eligible rows via prisma.$queryRaw with a tagged
    // template literal. The first arg is a TemplateStringsArray, followed
    // by interpolated values. Concatenating the array yields the full SQL
    // with the values omitted — sufficient for asserting the filter shape.
    const deps = makeDeps([]);
    await runCollateralReleaseCycle(deps);

    const prisma = deps.prisma as unknown as { $queryRaw: jest.Mock };
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const template = prisma.$queryRaw.mock.calls[0]![0] as ArrayLike<string>;
    const sql = Array.from(template).join(' ');

    expect(sql).toMatch(/status\s*=/i);
    expect(sql).toMatch(/collateral_released_at\s+IS\s+NULL/i);
    expect(sql).toMatch(/collateral_release_address\s+IS\s+NOT\s+NULL/i);
    expect(sql).toMatch(/FOR\s+UPDATE\s+SKIP\s+LOCKED/i);
  });

  it('logs each ReleaseResult variant without throwing', async () => {
    const deps = makeDeps([
      eligibleRow('loan-released'),
      eligibleRow('loan-already'),
      eligibleRow('loan-inflight'),
      eligibleRow('loan-noteligible'),
      eligibleRow('loan-failed'),
    ]);
    deps.release.releaseForLoan
      .mockResolvedValueOnce({ status: 'released',         reference: 'r1' })
      .mockResolvedValueOnce({ status: 'already_released', reference: 'old' })
      .mockResolvedValueOnce({ status: 'in_flight' })
      .mockResolvedValueOnce({ status: 'not_eligible',     reason:    'race' })
      .mockResolvedValueOnce({ status: 'send_failed',      error:     'Insufficient route' });

    await expect(runCollateralReleaseCycle(deps)).resolves.not.toThrow();
    expect(deps.release.releaseForLoan).toHaveBeenCalledTimes(5);

    const events = deps.log.mock.calls.map((c) => c[1]);
    expect(events).toEqual(expect.arrayContaining([
      'released', 'already_released', 'in_flight', 'not_eligible', 'send_failed', 'cycle_complete',
    ]));
  });

  it('tolerates a thrown release call and continues with the next row', async () => {
    const deps = makeDeps([eligibleRow(LOAN_A), eligibleRow(LOAN_B)]);
    deps.release.releaseForLoan
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(ok());

    await expect(runCollateralReleaseCycle(deps)).resolves.not.toThrow();
    expect(deps.release.releaseForLoan).toHaveBeenCalledTimes(2);
    const error_events = deps.log.mock.calls.filter((c) => c[1] === 'release_threw');
    expect(error_events).toHaveLength(1);
  });
});
