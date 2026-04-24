import Decimal from 'decimal.js';
import { AccrualService, type AccrualLoanInput, type AccrualRepaymentInput } from '@/modules/loans/accrual.service';

// ── Fixtures ──────────────────────────────────────────────────────────────────
// Worked example from docs/repayment-matching-redesign.md §3:
//   principal              = N500,000
//   daily_interest_rate    = 30 bps (0.3%)
//   daily_custody_fee      = N700/day (fixed at origination)
//   collateral_received_at = 2026-04-22T00:00:00Z

const COLLATERAL_AT = new Date('2026-04-22T00:00:00Z');

const LOAN: AccrualLoanInput = {
  principal_ngn:           new Decimal('500000'),
  daily_interest_rate_bps: 30,
  daily_custody_fee_ngn:   new Decimal('700'),
  collateral_received_at:  COLLATERAL_AT,
};

const MS = (n: number) => n;
const HOURS = (n: number) => n * 3600 * 1000;
const DAYS  = (n: number) => n * 24 * 3600 * 1000;

function addMs(d: Date, ms: number): Date {
  return new Date(d.getTime() + ms);
}

function svc() {
  return new AccrualService();
}

// ── Never-activated loan ──────────────────────────────────────────────────────

describe('AccrualService — never-activated loan', () => {
  it('collateral_received_at = null → days=0, outstanding = principal', () => {
    const result = svc().compute({
      loan: { ...LOAN, collateral_received_at: null },
      repayments: [],
      as_of: new Date('2026-05-01T00:00:00Z'),
    });
    expect(result.days_elapsed).toBe(0);
    expect(result.principal_ngn).toEqual(LOAN.principal_ngn);
    expect(result.accrued_interest_ngn).toEqual(new Decimal(0));
    expect(result.accrued_custody_ngn).toEqual(new Decimal(0));
    expect(result.total_outstanding_ngn).toEqual(LOAN.principal_ngn);
  });
});

// ── Day-boundary behaviour (ceil to 24h buckets) ──────────────────────────────

describe('AccrualService — day-boundary rule', () => {
  it('as_of = collateral_received_at → 0 days elapsed', () => {
    const result = svc().compute({ loan: LOAN, repayments: [], as_of: COLLATERAL_AT });
    expect(result.days_elapsed).toBe(0);
    expect(result.accrued_interest_ngn).toEqual(new Decimal(0));
    expect(result.accrued_custody_ngn).toEqual(new Decimal(0));
  });

  it('1 ms after origination → 1 day (partial days ceil up)', () => {
    const result = svc().compute({ loan: LOAN, repayments: [], as_of: addMs(COLLATERAL_AT, MS(1)) });
    expect(result.days_elapsed).toBe(1);
  });

  it('2 hours after origination → 1 day (worked-example invariant)', () => {
    const result = svc().compute({ loan: LOAN, repayments: [], as_of: addMs(COLLATERAL_AT, HOURS(2)) });
    expect(result.days_elapsed).toBe(1);
    // 500_000 × 0.003 × 1 = 1500
    expect(result.accrued_interest_ngn).toEqual(new Decimal('1500'));
    expect(result.accrued_custody_ngn).toEqual(new Decimal('700'));
  });

  it('exactly 24h → 1 day', () => {
    const result = svc().compute({ loan: LOAN, repayments: [], as_of: addMs(COLLATERAL_AT, DAYS(1)) });
    expect(result.days_elapsed).toBe(1);
  });

  it('24h + 1 ms → 2 days', () => {
    const result = svc().compute({ loan: LOAN, repayments: [], as_of: addMs(COLLATERAL_AT, DAYS(1) + MS(1)) });
    expect(result.days_elapsed).toBe(2);
  });
});

// ── Zero-repayment accrual (linear in days) ───────────────────────────────────

describe('AccrualService — zero-repayment accrual', () => {
  it('at day 30 with no repayments — matches worked example (N566,000)', () => {
    const result = svc().compute({ loan: LOAN, repayments: [], as_of: addMs(COLLATERAL_AT, DAYS(30)) });
    expect(result.days_elapsed).toBe(30);
    // interest = 500_000 × 0.003 × 30 = 45,000
    expect(result.accrued_interest_ngn).toEqual(new Decimal('45000'));
    // custody  = 700 × 30 = 21,000
    expect(result.accrued_custody_ngn).toEqual(new Decimal('21000'));
    // total    = 500_000 + 45,000 + 21,000
    expect(result.total_outstanding_ngn).toEqual(new Decimal('566000'));
    expect(result.principal_ngn).toEqual(new Decimal('500000'));
  });

  it('at day 90 with no repayments', () => {
    const result = svc().compute({ loan: LOAN, repayments: [], as_of: addMs(COLLATERAL_AT, DAYS(90)) });
    expect(result.days_elapsed).toBe(90);
    // interest = 500_000 × 0.003 × 90 = 135,000
    expect(result.accrued_interest_ngn).toEqual(new Decimal('135000'));
    expect(result.accrued_custody_ngn).toEqual(new Decimal('63000'));
    expect(result.total_outstanding_ngn).toEqual(new Decimal('698000'));
  });
});

// ── Single partial repayment — reducing-balance interest ──────────────────────

describe('AccrualService — single partial repayment', () => {
  // Day-30 repayment of N100,000 applied as 21k custody + 45k interest + 34k principal
  const REPAYMENT: AccrualRepaymentInput = {
    applied_to_custody:   new Decimal('21000'),
    applied_to_interest:  new Decimal('45000'),
    applied_to_principal: new Decimal('34000'),
    created_at:           addMs(COLLATERAL_AT, DAYS(30)),
  };

  it('at day 60 matches worked example — outstanding N528,940', () => {
    const result = svc().compute({
      loan: LOAN,
      repayments: [REPAYMENT],
      as_of: addMs(COLLATERAL_AT, DAYS(60)),
    });
    // principal after repayment: 500_000 - 34_000 = 466_000
    expect(result.principal_ngn).toEqual(new Decimal('466000'));

    // Days 1-30 interest @ 500k = 45,000 (paid); days 31-60 @ 466k = 41,940 (unpaid)
    expect(result.accrued_interest_ngn).toEqual(new Decimal('41940'));

    // Custody gross 700 × 60 = 42,000; paid 21,000 → 21,000 unpaid
    expect(result.accrued_custody_ngn).toEqual(new Decimal('21000'));

    // Total: 466,000 + 41,940 + 21,000 = 528,940
    expect(result.total_outstanding_ngn).toEqual(new Decimal('528940'));
  });

  it('at the exact instant of the repayment, the new principal applies from that day forward', () => {
    const result = svc().compute({
      loan: LOAN,
      repayments: [REPAYMENT],
      as_of: addMs(COLLATERAL_AT, DAYS(30)),
    });
    // days_elapsed = 30; gross interest = 500k × 0.003 × 30 = 45,000 (no further accrual yet)
    // paid = 45,000 → net 0
    expect(result.accrued_interest_ngn).toEqual(new Decimal(0));
    expect(result.principal_ngn).toEqual(new Decimal('466000'));
  });

  it('repayment at t=0 reduces principal for all interest accrual', () => {
    const zero_day: AccrualRepaymentInput = {
      applied_to_custody:   new Decimal(0),
      applied_to_interest:  new Decimal(0),
      applied_to_principal: new Decimal('100000'),
      created_at:           COLLATERAL_AT,
    };
    const result = svc().compute({
      loan: LOAN,
      repayments: [zero_day],
      as_of: addMs(COLLATERAL_AT, DAYS(30)),
    });
    // With principal dropped to 400k immediately: interest = 400k × 0.003 × 30 = 36,000
    expect(result.accrued_interest_ngn).toEqual(new Decimal('36000'));
    expect(result.principal_ngn).toEqual(new Decimal('400000'));
  });
});

// ── Multiple repayments — cumulative segments ─────────────────────────────────

describe('AccrualService — multiple repayments', () => {
  it('two repayments segment correctly — day 10, day 20', () => {
    const r1: AccrualRepaymentInput = {
      applied_to_custody:   new Decimal('7000'),
      applied_to_interest:  new Decimal('15000'),
      applied_to_principal: new Decimal('28000'),
      created_at:           addMs(COLLATERAL_AT, DAYS(10)),
    };
    const r2: AccrualRepaymentInput = {
      // At day 20: unpaid custody = 14,000 − 7,000 = 7,000; unpaid interest = 14,160; principal 472k
      applied_to_custody:   new Decimal('7000'),
      applied_to_interest:  new Decimal('14160'),
      applied_to_principal: new Decimal('28840'),
      created_at:           addMs(COLLATERAL_AT, DAYS(20)),
    };

    const result = svc().compute({
      loan: LOAN,
      repayments: [r1, r2],
      as_of: addMs(COLLATERAL_AT, DAYS(30)),
    });

    // Segment 1 (days 1-10 @ 500k):       500_000 × 0.003 × 10 = 15,000
    // Segment 2 (days 11-20 @ 472k):      472_000 × 0.003 × 10 = 14,160
    // Segment 3 (days 21-30 @ 443,160):   443,160 × 0.003 × 10 = 13,294.80
    // Gross interest = 42,454.80; paid 29,160 → unpaid 13,294.80
    expect(result.accrued_interest_ngn.toFixed(2)).toBe('13294.80');

    // Principal: 500,000 − 28,000 − 28,840 = 443,160
    expect(result.principal_ngn).toEqual(new Decimal('443160'));

    // Custody gross 21,000; paid 14,000 → unpaid 7,000
    expect(result.accrued_custody_ngn).toEqual(new Decimal('7000'));
  });

  it('repayments out of order in input are still processed chronologically', () => {
    const r_later: AccrualRepaymentInput = {
      applied_to_custody:   new Decimal(0),
      applied_to_interest:  new Decimal(0),
      applied_to_principal: new Decimal('100000'),
      created_at:           addMs(COLLATERAL_AT, DAYS(20)),
    };
    const r_earlier: AccrualRepaymentInput = {
      applied_to_custody:   new Decimal(0),
      applied_to_interest:  new Decimal(0),
      applied_to_principal: new Decimal('50000'),
      created_at:           addMs(COLLATERAL_AT, DAYS(10)),
    };

    const sorted   = svc().compute({ loan: LOAN, repayments: [r_earlier, r_later], as_of: addMs(COLLATERAL_AT, DAYS(30)) });
    const unsorted = svc().compute({ loan: LOAN, repayments: [r_later, r_earlier], as_of: addMs(COLLATERAL_AT, DAYS(30)) });
    expect(unsorted.accrued_interest_ngn).toEqual(sorted.accrued_interest_ngn);
    expect(unsorted.principal_ngn).toEqual(sorted.principal_ngn);
  });

  it('repayments after as_of are ignored', () => {
    const future_repayment: AccrualRepaymentInput = {
      applied_to_custody:   new Decimal('1000'),
      applied_to_interest:  new Decimal('1000'),
      applied_to_principal: new Decimal('1000'),
      created_at:           addMs(COLLATERAL_AT, DAYS(60)),
    };
    const result = svc().compute({
      loan: LOAN,
      repayments: [future_repayment],
      as_of: addMs(COLLATERAL_AT, DAYS(30)),
    });
    // As if no repayment happened yet.
    expect(result.principal_ngn).toEqual(new Decimal('500000'));
    expect(result.accrued_interest_ngn).toEqual(new Decimal('45000'));
    expect(result.accrued_custody_ngn).toEqual(new Decimal('21000'));
  });
});

// ── Floor at zero — over-application edge cases ───────────────────────────────

describe('AccrualService — flooring', () => {
  it('over-paid principal → outstanding_principal = 0 (not negative)', () => {
    const over: AccrualRepaymentInput = {
      applied_to_custody:   new Decimal(0),
      applied_to_interest:  new Decimal(0),
      applied_to_principal: new Decimal('600000'),   // > principal
      created_at:           addMs(COLLATERAL_AT, DAYS(1)),
    };
    const result = svc().compute({
      loan: LOAN,
      repayments: [over],
      as_of: addMs(COLLATERAL_AT, DAYS(30)),
    });
    expect(result.principal_ngn).toEqual(new Decimal(0));
  });

  it('over-paid interest → accrued_interest = 0 (not negative)', () => {
    const over: AccrualRepaymentInput = {
      applied_to_custody:   new Decimal(0),
      applied_to_interest:  new Decimal('1000000'),   // absurdly over
      applied_to_principal: new Decimal(0),
      created_at:           COLLATERAL_AT,
    };
    const result = svc().compute({
      loan: LOAN,
      repayments: [over],
      as_of: addMs(COLLATERAL_AT, DAYS(30)),
    });
    expect(result.accrued_interest_ngn).toEqual(new Decimal(0));
  });

  it('over-paid custody → accrued_custody = 0 (not negative)', () => {
    const over: AccrualRepaymentInput = {
      applied_to_custody:   new Decimal('1000000'),
      applied_to_interest:  new Decimal(0),
      applied_to_principal: new Decimal(0),
      created_at:           COLLATERAL_AT,
    };
    const result = svc().compute({
      loan: LOAN,
      repayments: [over],
      as_of: addMs(COLLATERAL_AT, DAYS(30)),
    });
    expect(result.accrued_custody_ngn).toEqual(new Decimal(0));
  });
});

// ── Determinism ───────────────────────────────────────────────────────────────

describe('AccrualService — determinism', () => {
  it('same inputs produce same output across invocations', () => {
    const args = {
      loan: LOAN,
      repayments: [
        {
          applied_to_custody:   new Decimal('700'),
          applied_to_interest:  new Decimal('1500'),
          applied_to_principal: new Decimal('5000'),
          created_at:           addMs(COLLATERAL_AT, DAYS(7)),
        },
      ],
      as_of: addMs(COLLATERAL_AT, DAYS(15)),
    };
    const a = svc().compute(args);
    const b = svc().compute(args);
    expect(a.total_outstanding_ngn).toEqual(b.total_outstanding_ngn);
    expect(a.principal_ngn).toEqual(b.principal_ngn);
    expect(a.accrued_interest_ngn).toEqual(b.accrued_interest_ngn);
    expect(a.accrued_custody_ngn).toEqual(b.accrued_custody_ngn);
  });
});
