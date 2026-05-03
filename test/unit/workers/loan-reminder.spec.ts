import { runReminderCycle, type LoanReminderDeps, type SendEmail } from '../../../workers/loan-reminder.worker';
import {
  buildReminderEmail,
  determineCurrentSlot,
  type ReminderSlot,
} from '@/modules/loans/reminder-templates';
import { LoanStatus } from '@prisma/client';
import Decimal from 'decimal.js';
import { REDIS_KEYS } from '@/common/constants';

const LOAN_ID = 'loan-uuid-001';
const USER_ID = 'user-uuid-001';
const VA_NO    = '9012345678';
const VA_NAME  = 'Bitmonie Loan Repayment';
const VA_BANK  = 'Bloom Microfinance Bank';

// Pin "now" to a fixed instant. due_at offsets are computed relative to NOW
// so individual tests can choose where in the timeline a loan sits.
const NOW = new Date('2026-04-23T12:00:00Z');
const HOURS = (n: number) => n * 3600 * 1000;

function makeLoan(opts: {
  hours_from_due: number;        // negative = before maturity, positive = after
} = { hours_from_due: 0 }) {
  const due_at = new Date(NOW.getTime() - HOURS(opts.hours_from_due));
  return {
    id:                       LOAN_ID,
    user_id:                  USER_ID,
    due_at,
    principal_ngn:            new Decimal('500000'),
    daily_interest_rate_bps:  30,
    daily_custody_fee_ngn:    new Decimal('700'),
    collateral_received_at:   new Date(due_at.getTime() - 30 * 86400_000), // 30d before due
    user:                     { email: 'ada@test.com', first_name: 'Ada' },
    repayments:               [],
  };
}

function makeDeps(overrides: {
  loans?: ReturnType<typeof makeLoan>[];
  accounts?: Array<{ user_id: string; virtual_account_no: string; virtual_account_name: string; bank_name: string }>;
  redis_get?: jest.Mock;
} = {}) {
  const loans     = overrides.loans     ?? [];
  const accounts  = overrides.accounts  ?? [{ user_id: USER_ID, virtual_account_no: VA_NO, virtual_account_name: VA_NAME, bank_name: VA_BANK }];
  const redis_get = overrides.redis_get ?? jest.fn().mockResolvedValue(null);

  const prisma = {
    loan: { findMany: jest.fn().mockResolvedValue(loans) },
    userRepaymentAccount: { findMany: jest.fn().mockResolvedValue(accounts) },
  } as unknown as LoanReminderDeps['prisma'];

  const redis = {
    get: redis_get,
    set: jest.fn().mockResolvedValue('OK'),
  } as unknown as LoanReminderDeps['redis'];

  const send_email: SendEmail = jest.fn().mockResolvedValue(undefined);
  const log = jest.fn();

  return { prisma, redis, send_email, log, now: () => NOW } as unknown as LoanReminderDeps & {
    prisma:     { loan: { findMany: jest.Mock }; userRepaymentAccount: { findMany: jest.Mock } };
    redis:      { get: jest.Mock; set: jest.Mock };
    send_email: jest.Mock;
    log:        jest.Mock;
  };
}

// ── determineCurrentSlot (pure function) ─────────────────────────────────────

describe('determineCurrentSlot', () => {
  const due_at = new Date('2026-05-01T00:00:00Z');
  const hours = (h: number) => new Date(due_at.getTime() + h * 3_600_000);

  const cases: Array<[number, ReminderSlot | null]> = [
    [-200, null],          // > 7d before maturity → no slot
    [-168, 't_minus_7d'],  // exactly T-7d
    [-100, 't_minus_7d'],  // 4d before
    [-24,  't_minus_1d'],  // exactly T-1d
    [-1,   't_minus_1d'],  // 1h before maturity
    [0,    't_maturity'],  // at maturity
    [12,   't_maturity'],  // half a day in
    [24,   'grace_d1'],    // exactly T+1d
    [48,   'grace_d2'],
    [72,   'grace_d3'],
    [96,   'grace_d4'],
    [120,  'grace_d5'],
    [144,  'grace_d6'],
    [168,  'grace_final'], // exactly T+7d (last day before liquidation)
    [192,  'grace_final'], // beyond grace_final, still returns it (liquidation worker handles cutoff)
  ];

  for (const [h, expected] of cases) {
    it(`hours_from_due=${h} → ${expected ?? 'null'}`, () => {
      expect(determineCurrentSlot(due_at, hours(h))).toBe(expected);
    });
  }
});

// ── buildReminderEmail (pure function) ───────────────────────────────────────

describe('buildReminderEmail', () => {
  const baseParams = {
    first_name:           'Ada',
    loan_id:              'aabbccdd-eeff-0011-2233-445566778899',
    outstanding_ngn:      '566000',
    // N500k principal × 0.3% = N1,500/day interest; N700/day fixed custody.
    principal_remaining_ngn: '500000',
    daily_interest_ngn:      '1500',
    daily_custody_ngn:       '700',
    daily_total_ngn:         '2200',
    virtual_account_no:   VA_NO,
    virtual_account_name: VA_NAME,
    bank_name:            VA_BANK,
    due_at:               new Date('2026-05-01T00:00:00Z'),
  };

  it('t_minus_7d subject mentions 7 days', () => {
    const e = buildReminderEmail('t_minus_7d', baseParams);
    expect(e.subject).toMatch(/7 days/i);
  });

  it('t_minus_1d subject mentions tomorrow', () => {
    const e = buildReminderEmail('t_minus_1d', baseParams);
    expect(e.subject).toMatch(/tomorrow/i);
  });

  it('t_maturity subject mentions TODAY', () => {
    const e = buildReminderEmail('t_maturity', baseParams);
    expect(e.subject).toMatch(/today/i);
  });

  it('grace_final subject is a FINAL NOTICE', () => {
    const e = buildReminderEmail('grace_final', baseParams);
    expect(e.subject).toMatch(/FINAL NOTICE/i);
  });

  it('grace_d3 subject mentions 3 days overdue', () => {
    const e = buildReminderEmail('grace_d3', baseParams);
    expect(e.subject).toMatch(/3 days overdue/i);
  });

  it('every email includes the VA number and outstanding amount', () => {
    const slots: ReminderSlot[] = ['t_minus_7d', 't_minus_1d', 't_maturity', 'grace_d1', 'grace_d6', 'grace_final'];
    for (const slot of slots) {
      const e = buildReminderEmail(slot, baseParams);
      expect(e.text_body).toContain(VA_NO);
      expect(e.text_body).toContain('566,000');
      expect(e.html_body).toContain(VA_NO);
      expect(e.html_body).toContain('566,000');
    }
  });

  // Without the bank label customers can't actually find the VA on their
  // banking app's transfer screen — so every reminder slot must surface it.
  it('every email surfaces the partner bank name', () => {
    const slots: ReminderSlot[] = ['t_minus_7d', 't_minus_1d', 't_maturity', 'grace_d1', 'grace_d6', 'grace_final'];
    for (const slot of slots) {
      const e = buildReminderEmail(slot, baseParams);
      expect(e.text_body).toContain(VA_BANK);
      expect(e.html_body).toContain(VA_BANK);
    }
  });

  it('HTML escapes user-controlled fields (defends against name injection)', () => {
    const e = buildReminderEmail('t_minus_7d', { ...baseParams, virtual_account_name: '<script>x</script>' });
    expect(e.html_body).not.toContain('<script>');
    expect(e.html_body).toContain('&lt;script&gt;');
  });

  // Daily-accrual disclosure — present on every slot EXCEPT grace_final, which
  // is liquidation-focused and shouldn't dilute the urgency.
  it('non-final slots include the daily-accrual block (interest + custody + total)', () => {
    const slots: ReminderSlot[] = [
      't_minus_7d', 't_minus_1d', 't_maturity',
      'grace_d1', 'grace_d2', 'grace_d3', 'grace_d4', 'grace_d5', 'grace_d6',
    ];
    for (const slot of slots) {
      const e = buildReminderEmail(slot, baseParams);
      expect(e.text_body).toContain('₦2,200');         // daily total
      expect(e.text_body).toContain('500,000');        // remaining principal
      expect(e.text_body).toContain('1,500');          // daily interest
      expect(e.text_body).toContain('700');            // daily custody
      expect(e.text_body).toContain('0.3% interest');
      expect(e.html_body).toContain('₦2,200');
    }
  });

  it('grace_final omits the daily-accrual block (final-notice mode is liquidation-focused)', () => {
    const e = buildReminderEmail('grace_final', baseParams);
    expect(e.text_body).not.toContain('Each day this stays open');
    expect(e.html_body).not.toContain('Each day this stays open');
  });
});

// ── runReminderCycle ─────────────────────────────────────────────────────────

describe('runReminderCycle', () => {
  it('does nothing when no candidate loans are returned', async () => {
    const deps = makeDeps({ loans: [] });

    await runReminderCycle(deps);

    expect(deps.send_email).not.toHaveBeenCalled();
    expect(deps.redis.set).toHaveBeenCalledWith(
      REDIS_KEYS.WORKER_HEARTBEAT('loan_reminder'),
      expect.any(String),
    );
  });

  it('sends an email and marks Redis when a loan reaches a fresh slot', async () => {
    const deps = makeDeps({ loans: [makeLoan({ hours_from_due: -168 })] }); // exactly T-7d → t_minus_7d

    await runReminderCycle(deps);

    expect(deps.send_email).toHaveBeenCalledTimes(1);
    expect(deps.send_email).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ada@test.com',
        subject: expect.stringMatching(/7 days/i),
      }),
    );
    expect(deps.redis.set).toHaveBeenCalledWith(
      REDIS_KEYS.REMINDER_SENT(LOAN_ID, 't_minus_7d'),
      '1',
      'EX',
      expect.any(Number),
    );
  });

  it('skips when the slot was already sent (Redis hit)', async () => {
    const redis_get = jest.fn().mockResolvedValue('1');
    const deps = makeDeps({
      loans:     [makeLoan({ hours_from_due: 0 })],
      redis_get,
    });

    await runReminderCycle(deps);

    expect(deps.send_email).not.toHaveBeenCalled();
    // Heartbeat set, but reminder marker NOT set (already there).
    expect(deps.redis.set).not.toHaveBeenCalledWith(
      REDIS_KEYS.REMINDER_SENT(LOAN_ID, 't_maturity'),
      expect.any(String),
      expect.any(String),
      expect.any(Number),
    );
  });

  it('skips loans without a repayment account (logs warning)', async () => {
    const deps = makeDeps({
      loans:    [makeLoan({ hours_from_due: 0 })],
      accounts: [],
    });

    await runReminderCycle(deps);

    expect(deps.send_email).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(
      'warn',
      'reminder_skipped_no_va',
      expect.objectContaining({ loan_id: LOAN_ID, slot: 't_maturity' }),
    );
  });

  it('continues processing other loans when one send fails', async () => {
    const loan_a = { ...makeLoan({ hours_from_due: 0 }), id: 'loan-uuid-A', user_id: 'user-A' };
    const loan_b = { ...makeLoan({ hours_from_due: 0 }), id: 'loan-uuid-B', user_id: 'user-B' };

    const deps = makeDeps({
      loans:    [loan_a, loan_b],
      accounts: [
        { user_id: 'user-A', virtual_account_no: '111', virtual_account_name: 'A', bank_name: VA_BANK },
        { user_id: 'user-B', virtual_account_no: '222', virtual_account_name: 'B', bank_name: VA_BANK },
      ],
    });
    deps.send_email.mockRejectedValueOnce(new Error('Mailgun 503'));

    await runReminderCycle(deps);

    // loan-A failed, loan-B should still go through
    expect(deps.send_email).toHaveBeenCalledTimes(2);
    expect(deps.log).toHaveBeenCalledWith(
      'error',
      'reminder_failed',
      expect.objectContaining({ loan_id: 'loan-uuid-A' }),
    );
  });

  it('passes the computed outstanding amount into the email body', async () => {
    // Loan at maturity (hours_from_due=0). collateral_received_at is 30d before due.
    // Accrual at as_of=NOW → days_elapsed=30: interest 45,000 + custody 21,000 → outstanding 566,000.
    const deps = makeDeps({ loans: [makeLoan({ hours_from_due: 0 })] });

    await runReminderCycle(deps);

    const args = deps.send_email.mock.calls[0]![0];
    expect(args.text_body).toContain('566,000');
  });

  it('queries only loans whose due_at is within ±8 days of now', async () => {
    const deps = makeDeps({ loans: [] });

    await runReminderCycle(deps);

    const where = deps.prisma.loan.findMany.mock.calls[0]![0].where;
    expect(where.status).toBe(LoanStatus.ACTIVE);
    expect(where.due_at).toEqual({
      gte: expect.any(Date),
      lte: expect.any(Date),
    });
    const span_ms = where.due_at.lte.getTime() - where.due_at.gte.getTime();
    expect(span_ms).toBe(16 * 86400_000); // 8d before + 8d after = 16d total
  });
});
