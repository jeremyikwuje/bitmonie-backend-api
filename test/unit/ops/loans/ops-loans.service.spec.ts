import Decimal from 'decimal.js';
import { LoanStatus, StatusTrigger } from '@prisma/client';
import { OpsLoansService } from '@/modules/ops/loans/ops-loans.service';
import { OpsAuditService } from '@/modules/ops/auth/ops-audit.service';
import { OPS_ACTION, OPS_TARGET_TYPE } from '@/common/constants/ops-actions';
import { LoanReasonCodes, MIN_LIQUIDATION_RATE_FRACTION } from '@/common/constants';
import {
  LoanNotFoundException,
  LoanNotLiquidatedException,
  LiquidationNotBadRateException,
} from '@/common/errors/bitmonie.errors';

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

  // The reminders diagnostic uses Redis but restoreFromBadLiquidation tests
  // don't — provide a stub that throws if hit so a regression that adds
  // unintended Redis traffic to the restore path is loud.
  const redis = {
    pipeline: () => { throw new Error('redis.pipeline() is not expected on this code path'); },
  } as unknown as import('ioredis').default;

  const service = new OpsLoansService(prisma as never, ops_audit, redis);
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

// ── getReminders (diagnostic) ─────────────────────────────────────────────────

describe('OpsLoansService.getReminders', () => {
  const DUE_AT = new Date('2026-04-29T18:00:00.000Z');

  // Builds a service that returns a fake `loan` from prisma and a Redis
  // pipeline that returns the supplied per-key replies, in the order
  // `getReminders` issues them: heartbeat first, then for each slot an
  // EXISTS reply followed by a TTL reply.
  function makeService(opts: {
    loan: { id: string; due_at: Date } | null;
    heartbeat_raw: string | null;
    // Map from slot name → { exists: 0|1, ttl: number } where ttl follows
    // ioredis sentinels: -2 = no key, -1 = no TTL, >=0 = remaining seconds.
    slot_state: Record<string, { exists: 0 | 1; ttl: number }>;
    now?: Date;
  }) {
    const { REMINDER_SLOTS } = jest.requireActual('@/modules/loans/reminder-templates') as {
      REMINDER_SLOTS: Array<{ slot: string; offset_hours: number }>;
    };

    const replies: Array<[Error | null, unknown]> = [[null, opts.heartbeat_raw]];
    for (const { slot } of REMINDER_SLOTS) {
      const s = opts.slot_state[slot] ?? { exists: 0, ttl: -2 };
      replies.push([null, s.exists]);
      replies.push([null, s.ttl]);
    }

    const pipeline = {
      get:    jest.fn().mockReturnThis(),
      exists: jest.fn().mockReturnThis(),
      ttl:    jest.fn().mockReturnThis(),
      exec:   jest.fn().mockResolvedValue(replies),
    };
    const redis = { pipeline: () => pipeline } as unknown as import('ioredis').default;

    const prisma = {
      loan: { findUnique: jest.fn().mockResolvedValue(opts.loan) },
    };
    const ops_audit = { write: jest.fn() } as unknown as OpsAuditService;

    if (opts.now) jest.useFakeTimers().setSystemTime(opts.now);

    const service = new OpsLoansService(prisma as never, ops_audit, redis);
    return { service, prisma, pipeline };
  }

  afterEach(() => jest.useRealTimers());

  it('throws LoanNotFoundException when the loan does not exist', async () => {
    const { service } = makeService({ loan: null, heartbeat_raw: null, slot_state: {} });
    await expect(service.getReminders(LOAN_ID)).rejects.toBeInstanceOf(LoanNotFoundException);
  });

  it('returns expected_slot=t_maturity for a loan that hit due_at hours ago, and reports the dedup-present slot', async () => {
    // 4h past maturity → slot table for the worker is t_maturity.
    const now = new Date(DUE_AT.getTime() + 4 * 3_600_000);
    // Earlier slots already deduped (worker fired them last week / yesterday);
    // t_maturity not yet sent (this is the production scenario the endpoint
    // is meant to expose).
    const { service } = makeService({
      loan:          { id: LOAN_ID, due_at: DUE_AT },
      heartbeat_raw: String(now.getTime() - 10 * 60 * 1000), // 10min old → healthy
      slot_state: {
        t_minus_7d: { exists: 1, ttl: 7_500_000 },
        t_minus_1d: { exists: 1, ttl: 7_500_000 },
        t_maturity: { exists: 0, ttl: -2 }, // not sent yet
      },
      now,
    });

    const out = await service.getReminders(LOAN_ID);

    expect(out.loan_id).toBe(LOAN_ID);
    expect(out.due_at).toEqual(DUE_AT);
    expect(out.hours_from_due).toBeCloseTo(4, 6);
    expect(out.expected_slot).toBe('t_maturity');

    const t_maturity = out.slots.find((s) => s.slot === 't_maturity')!;
    expect(t_maturity.dedup_present).toBe(false);
    expect(t_maturity.ttl_seconds).toBeNull();

    const t_minus_1d = out.slots.find((s) => s.slot === 't_minus_1d')!;
    expect(t_minus_1d.dedup_present).toBe(true);
    expect(t_minus_1d.ttl_seconds).toBe(7_500_000);
  });

  it('reports worker_heartbeat=null when the worker has never written a heartbeat', async () => {
    const { service } = makeService({
      loan:          { id: LOAN_ID, due_at: DUE_AT },
      heartbeat_raw: null, // scheduler has not booted yet
      slot_state:    {},
      now:           new Date(DUE_AT.getTime() + 4 * 3_600_000),
    });
    const out = await service.getReminders(LOAN_ID);
    expect(out.worker_heartbeat).toBeNull();
  });

  it('marks heartbeat unhealthy when older than 2× the worker tick interval', async () => {
    const now = new Date(DUE_AT.getTime() + 4 * 3_600_000);
    // 3h old > 2h healthy threshold → unhealthy. This is the "scheduler
    // crashed silently" signature.
    const { service } = makeService({
      loan:          { id: LOAN_ID, due_at: DUE_AT },
      heartbeat_raw: String(now.getTime() - 3 * 60 * 60 * 1000),
      slot_state:    {},
      now,
    });
    const out = await service.getReminders(LOAN_ID);
    expect(out.worker_heartbeat?.healthy).toBe(false);
    expect(out.worker_heartbeat?.age_seconds).toBe(3 * 3600);
  });
});
