import Decimal from 'decimal.js';
import { LoanStatus, StatusTrigger } from '@prisma/client';
import { OpsLoansService } from '@/modules/ops/loans/ops-loans.service';
import { OpsAuditService } from '@/modules/ops/auth/ops-audit.service';
import { OPS_ACTION, OPS_TARGET_TYPE } from '@/common/constants/ops-actions';
import { LoanReasonCodes, MIN_LIQUIDATION_RATE_FRACTION } from '@/common/constants';
import {
  CollateralReleaseNotEligibleException,
  CollateralReleaseSendFailedException,
  LoanNotFoundException,
  LoanNotLiquidatedException,
  LiquidationNotBadRateException,
} from '@/common/errors/bitmonie.errors';
import type { CollateralReleaseService } from '@/modules/loans/collateral-release.service';

const LOAN_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OPS_USER_ID = '99999999-8888-7777-6666-555555555555';

const CTX = {
  ops_user_id: OPS_USER_ID,
  request_id:  'req_abc',
  ip_address:  '1.2.3.4',
};

interface LoanRow {
  id:                       string;
  user_id:                  string;
  status:                   LoanStatus;
  liquidated_at:            Date | null;
  liquidation_rate_actual:  Decimal | null;
  sat_ngn_rate_at_creation: Decimal;
}

function makeLoan(overrides: Partial<LoanRow> = {}): LoanRow {
  return {
    id:                       LOAN_ID,
    user_id:                  USER_ID,
    status:                   LoanStatus.LIQUIDATED,
    liquidated_at:            new Date('2026-04-28T21:18:54.000Z'),
    liquidation_rate_actual:  new Decimal('0'),
    sat_ngn_rate_at_creation: new Decimal('1.000000'),
    ...overrides,
  };
}

interface MockTx {
  loan:           { update: jest.Mock };
  loanStatusLog:  { create: jest.Mock };
}

function makeService(loan: LoanRow | null) {
  const tx: MockTx = {
    loan:          { update: jest.fn().mockResolvedValue({}) },
    loanStatusLog: { create: jest.fn().mockResolvedValue({}) },
  };

  const prisma = {
    loan: { findUnique: jest.fn().mockResolvedValue(loan) },
    $transaction: jest.fn().mockImplementation((fn: (tx: MockTx) => Promise<unknown>) => fn(tx)),
  };

  const audit_write = jest.fn().mockResolvedValue(undefined);
  const ops_audit = { write: audit_write } as unknown as OpsAuditService;

  const collateral_release = {
    releaseForLoan: jest.fn().mockRejectedValue(
      new Error('collateral_release.releaseForLoan() is not expected on this code path'),
    ),
  } as unknown as import('@/modules/loans/collateral-release.service').CollateralReleaseService;
  const service = new OpsLoansService(prisma as never, ops_audit, collateral_release);
  return { service, prisma, tx, audit_write };
}

describe('OpsLoansService.restoreFromBadLiquidation', () => {
  it('throws LoanNotFoundException when loan does not exist', async () => {
    const { service } = makeService(null);
    await expect(
      service.restoreFromBadLiquidation(LOAN_ID, 'why', CTX),
    ).rejects.toBeInstanceOf(LoanNotFoundException);
  });

  it('throws LoanNotLiquidatedException when status is not LIQUIDATED', async () => {
    const loan = makeLoan({ status: LoanStatus.ACTIVE });
    const { service } = makeService(loan);
    await expect(
      service.restoreFromBadLiquidation(LOAN_ID, 'why', CTX),
    ).rejects.toBeInstanceOf(LoanNotLiquidatedException);
  });

  it('throws LiquidationNotBadRateException when rate is at or above sanity floor', async () => {
    // baseline=1.0, floor=0.5; actual rate=0.7 → market-driven, refused.
    const loan = makeLoan({
      sat_ngn_rate_at_creation: new Decimal('1.000000'),
      liquidation_rate_actual:  new Decimal('0.700000'),
    });
    const { service } = makeService(loan);
    await expect(
      service.restoreFromBadLiquidation(LOAN_ID, 'why', CTX),
    ).rejects.toBeInstanceOf(LiquidationNotBadRateException);
  });

  it('treats null liquidation_rate_actual as bad-rate signature', async () => {
    const loan = makeLoan({ liquidation_rate_actual: null });
    const { service, tx, audit_write } = makeService(loan);

    await service.restoreFromBadLiquidation(LOAN_ID, 'fix it', CTX);

    expect(tx.loan.update).toHaveBeenCalled();
    expect(tx.loanStatusLog.create).toHaveBeenCalled();
    expect(audit_write).toHaveBeenCalled();
  });

  it('on success: clears liquidation fields, writes status log, writes audit row in same tx', async () => {
    const loan = makeLoan({
      sat_ngn_rate_at_creation: new Decimal('1.056905'),  // matches the user's actual loan
      liquidation_rate_actual:  new Decimal('0'),
    });
    const { service, prisma, tx, audit_write } = makeService(loan);

    await service.restoreFromBadLiquidation(LOAN_ID, 'bad price feed', CTX);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    expect(tx.loan.update).toHaveBeenCalledWith({
      where: { id: LOAN_ID },
      data: {
        status:                  LoanStatus.ACTIVE,
        liquidated_at:           null,
        liquidation_rate_actual: null,
      },
    });

    expect(tx.loanStatusLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        loan_id:        LOAN_ID,
        user_id:        USER_ID,
        from_status:    LoanStatus.LIQUIDATED,
        to_status:      LoanStatus.ACTIVE,
        triggered_by:   StatusTrigger.SYSTEM,
        triggered_by_id: OPS_USER_ID,
        reason_code:    LoanReasonCodes.LIQUIDATION_REVERSED_BAD_RATE,
        reason_detail:  'bad price feed',
      }),
    });

    expect(audit_write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        ops_user_id: OPS_USER_ID,
        action:      OPS_ACTION.LOAN_RESTORE_BAD_LIQUIDATION,
        target_type: OPS_TARGET_TYPE.LOAN,
        target_id:   LOAN_ID,
        request_id:  'req_abc',
        ip_address:  '1.2.3.4',
      }),
    );

    // The audit details must include the original (bad) rate so the audit log
    // is self-contained and doesn't depend on JOINing back to the loan row,
    // which has been mutated.
    const audit_call = audit_write.mock.calls[0]?.[1] as { details: Record<string, unknown> };
    expect(audit_call.details).toMatchObject({
      previous_status:                 LoanStatus.LIQUIDATED,
      original_liquidation_rate_actual: '0',
      reason:                          'bad price feed',
    });
  });

  it('uses the per-loan sanity floor — a loan whose origination rate was high needs a higher actual rate to be considered legit', async () => {
    // baseline=10, floor=5; actual=4 → still bad despite being non-zero.
    const loan = makeLoan({
      sat_ngn_rate_at_creation: new Decimal('10.000000'),
      liquidation_rate_actual:  new Decimal('4.000000'),
    });
    const { service, tx } = makeService(loan);

    await service.restoreFromBadLiquidation(LOAN_ID, 'high baseline restore', CTX);

    expect(tx.loan.update).toHaveBeenCalled();
  });

  it('does not restore at the sanity-floor exact value (uses < not <=)', async () => {
    // baseline=1.0, floor=0.5; actual=0.5 → exactly at floor, NOT considered bad.
    // Matches the worker's `current_rate.lt(sanity_floor)` check.
    const baseline = new Decimal('1.000000');
    const floor    = baseline.mul(MIN_LIQUIDATION_RATE_FRACTION);
    const loan = makeLoan({
      sat_ngn_rate_at_creation: baseline,
      liquidation_rate_actual:  floor,
    });
    const { service } = makeService(loan);
    await expect(
      service.restoreFromBadLiquidation(LOAN_ID, 'why', CTX),
    ).rejects.toBeInstanceOf(LiquidationNotBadRateException);
  });
});

// ── releaseCollateral ──────────────────────────────────────────────────────

describe('OpsLoansService.releaseCollateral', () => {
  function makeReleaseService(opts: {
    loan: { id: string; status: LoanStatus; collateral_release_address: string | null; collateral_released_at: Date | null; collateral_release_reference: string | null } | null;
    release_result?: Awaited<ReturnType<CollateralReleaseService['releaseForLoan']>>;
    release_throws?: Error;
  }) {
    const prisma = {
      loan: { findUnique: jest.fn().mockResolvedValue(opts.loan) },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ opsAuditLog: { create: jest.fn().mockResolvedValue({}) } }),
      ),
    };
    const audit_write = jest.fn().mockResolvedValue(undefined);
    const ops_audit = { write: audit_write } as unknown as OpsAuditService;

    const release_mock = jest.fn();
    if (opts.release_throws) release_mock.mockRejectedValue(opts.release_throws);
    else if (opts.release_result) release_mock.mockResolvedValue(opts.release_result);
    else release_mock.mockResolvedValue({ status: 'released', reference: 'ref-1' });

    const collateral_release = {
      releaseForLoan: release_mock,
    } as unknown as CollateralReleaseService;

    const service = new OpsLoansService(prisma as never, ops_audit, collateral_release);
    return { service, audit_write, release_mock };
  }

  const RELEASE_LOAN_ID = '22222222-3333-4444-5555-666666666666';
  function defaultLoan() {
    return {
      id:                           RELEASE_LOAN_ID,
      status:                       LoanStatus.REPAID,
      collateral_release_address:   'ada@blink.sv',
      collateral_released_at:       null,
      collateral_release_reference: null,
    };
  }

  it('throws LoanNotFoundException when the loan does not exist', async () => {
    const { service } = makeReleaseService({ loan: null });
    await expect(service.releaseCollateral(RELEASE_LOAN_ID, CTX)).rejects.toBeInstanceOf(LoanNotFoundException);
  });

  it('writes ops_audit_logs row before invoking CollateralReleaseService', async () => {
    const { service, audit_write, release_mock } = makeReleaseService({ loan: defaultLoan() });

    await service.releaseCollateral(RELEASE_LOAN_ID, CTX);

    expect(audit_write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ops_user_id: OPS_USER_ID,
        action:      OPS_ACTION.LOAN_RELEASE_COLLATERAL,
        target_type: OPS_TARGET_TYPE.LOAN,
        target_id:   RELEASE_LOAN_ID,
        request_id:  'req_abc',
        ip_address:  '1.2.3.4',
      }),
    );
    expect(release_mock).toHaveBeenCalledWith(RELEASE_LOAN_ID);
    // audit invoked before release
    expect(audit_write.mock.invocationCallOrder[0]).toBeLessThan(release_mock.mock.invocationCallOrder[0]!);
  });

  it('returns released + reference on the happy path', async () => {
    const { service } = makeReleaseService({
      loan: defaultLoan(),
      release_result: { status: 'released', reference: 'blink:ln_address:ada@blink.sv:42:0' },
    });

    const result = await service.releaseCollateral(RELEASE_LOAN_ID, CTX);
    expect(result).toEqual({ status: 'released', reference: 'blink:ln_address:ada@blink.sv:42:0' });
  });

  it('returns already_released when the service reports it was previously released', async () => {
    const { service } = makeReleaseService({
      loan: defaultLoan(),
      release_result: { status: 'already_released', reference: 'old-ref' },
    });

    const result = await service.releaseCollateral(RELEASE_LOAN_ID, CTX);
    expect(result).toEqual({ status: 'already_released', reference: 'old-ref' });
  });

  it('returns in_flight when another caller holds the lock', async () => {
    const { service } = makeReleaseService({
      loan: defaultLoan(),
      release_result: { status: 'in_flight' },
    });

    const result = await service.releaseCollateral(RELEASE_LOAN_ID, CTX);
    expect(result.status).toBe('in_flight');
  });

  it('translates not_eligible to CollateralReleaseNotEligibleException (409)', async () => {
    const { service } = makeReleaseService({
      loan: defaultLoan(),
      release_result: { status: 'not_eligible', reason: 'no_release_address' },
    });

    await expect(service.releaseCollateral(RELEASE_LOAN_ID, CTX))
      .rejects.toBeInstanceOf(CollateralReleaseNotEligibleException);
  });

  it('translates send_failed to CollateralReleaseSendFailedException (502)', async () => {
    const { service } = makeReleaseService({
      loan: defaultLoan(),
      release_result: { status: 'send_failed', error: 'Insufficient route' },
    });

    await expect(service.releaseCollateral(RELEASE_LOAN_ID, CTX))
      .rejects.toBeInstanceOf(CollateralReleaseSendFailedException);
  });
});
