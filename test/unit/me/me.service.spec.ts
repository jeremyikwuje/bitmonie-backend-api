import { Test, TestingModule } from '@nestjs/testing';
import { mock, MockProxy } from 'jest-mock-extended';
import { LoanStatus } from '@prisma/client';
import Decimal from 'decimal.js';
import { MeService } from '@/modules/me/me.service';
import { AccrualService } from '@/modules/loans/accrual.service';
import { PriceFeedService } from '@/modules/price-feed/price-feed.service';
import { PrismaService } from '@/database/prisma.service';

const USER_ID = 'user-uuid';

function make_prisma() {
  return {
    loan: { findMany: jest.fn().mockResolvedValue([]) },
    paymentRequest: { findMany: jest.fn().mockResolvedValue([]) },
    inflow: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

function make_loan(overrides: Partial<{
  id: string;
  status: LoanStatus;
  principal_ngn: string;
  collateral_amount_sat: bigint;
  collateral_release_address: string | null;
  collateral_received_at: Date | null;
  daily_interest_rate_bps: number;
  daily_custody_fee_ngn: string;
  repayments: unknown[];
}> = {}) {
  // AccrualService calls `.mul()` on principal_ngn + daily_custody_fee_ngn,
  // so these must be real Decimal instances (Prisma returns Decimal too).
  return {
    id: overrides.id ?? 'loan-uuid',
    status: overrides.status ?? LoanStatus.ACTIVE,
    principal_ngn: new Decimal(overrides.principal_ngn ?? '500000'),
    collateral_amount_sat: overrides.collateral_amount_sat ?? 1_500_000n,
    collateral_release_address: overrides.collateral_release_address ?? null,
    collateral_received_at: overrides.collateral_received_at ?? new Date('2026-01-01'),
    daily_interest_rate_bps: overrides.daily_interest_rate_bps ?? 30,
    daily_custody_fee_ngn: new Decimal(overrides.daily_custody_fee_ngn ?? '700'),
    repayments: overrides.repayments ?? [],
  };
}

describe('MeService', () => {
  let service: MeService;
  let prisma: ReturnType<typeof make_prisma>;
  let price_feed: MockProxy<PriceFeedService>;

  beforeEach(async () => {
    prisma = make_prisma();
    price_feed = mock<PriceFeedService>();
    // Default rate: 1 SAT = 0.0016 NGN → 1.5M SAT collateral = ₦2,400. Set high
    // enough that LIQUIDATION_RISK doesn't trip on the basic ACTIVE loan in tests
    // unless the test deliberately sets it low.
    price_feed.getCurrentRate.mockResolvedValue({
      rate_buy: new Decimal('0.50'),
      rate_sell: new Decimal('0.48'),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MeService,
        AccrualService,
        { provide: PrismaService, useValue: prisma },
        { provide: PriceFeedService, useValue: price_feed },
      ],
    }).compile();

    service = module.get(MeService);
  });

  it('returns zeroes when the user has no loans and no inflows', async () => {
    const result = await service.getSummary(USER_ID);

    expect(result.outstanding_ngn).toBe('0');
    expect(result.daily_accrual_ngn).toBe('0');
    expect(result.active_loan_count).toBe(0);
    expect(result.attention).toEqual([]);
    expect(result.unmatched_inflow_count).toBe(0);
    expect(result.unmatched_inflow_total_ngn).toBe('0');
    // No ACTIVE loan → don't waste a price-feed call. Keeps the endpoint
    // responsive even when the feed is degraded for non-ACTIVE users.
    expect(price_feed.getCurrentRate).not.toHaveBeenCalled();
  });

  it('computes daily_accrual_ngn = (outstanding principal × bps/10000) + daily_custody, summed across ACTIVE loans', async () => {
    // Two ACTIVE loans, no repayments → outstanding principal == initial principal.
    // make_loan defaults daily_custody_fee_ngn=700, daily_interest_rate_bps=30.
    //   loan A: ₦500,000 × 30bps = ₦1,500 interest + ₦700 custody = ₦2,200/day
    //   loan B: ₦200,000 × 30bps = ₦600 interest   + ₦700 custody = ₦1,300/day
    //   total                                                       = ₦3,500/day (ceil)
    prisma.loan.findMany.mockResolvedValue([
      make_loan({ id: 'loan-A', principal_ngn: '500000' }),
      make_loan({ id: 'loan-B', principal_ngn: '200000' }),
    ]);

    const result = await service.getSummary(USER_ID);

    expect(result.active_loan_count).toBe(2);
    expect(result.daily_accrual_ngn).toBe('3500');
  });

  it('emits a PENDING_COLLATERAL card with the matched payment-request expiry', async () => {
    const expires = new Date('2026-05-05T14:32:00Z');
    prisma.loan.findMany.mockResolvedValue([
      make_loan({ id: 'loan-1', status: LoanStatus.PENDING_COLLATERAL, collateral_received_at: null }),
    ]);
    prisma.paymentRequest.findMany.mockResolvedValue([
      { source_id: 'loan-1', expires_at: expires },
    ]);

    const result = await service.getSummary(USER_ID);

    expect(result.attention).toHaveLength(1);
    expect(result.attention[0]).toMatchObject({
      loan_id: 'loan-1',
      kind: 'PENDING_COLLATERAL',
      expires_at: expires.toISOString(),
    });
    expect(result.attention[0].title).toContain('SAT');
    expect(result.outstanding_ngn).toBe('0'); // PENDING is excluded from outstanding
    expect(result.active_loan_count).toBe(0);
  });

  it('emits LIQUIDATION_RISK when collateral_ngn < 1.20 × outstanding', async () => {
    // Set the rate low so 1.5M SAT × low_rate < 1.20 × ~₦500,000 outstanding.
    // 1.5M sat = 0.015 BTC. To make collateral_ngn = ₦500,000, we need
    // BTC/NGN = 500_000 / 0.015 ≈ ₦33,333,333 → SAT/NGN = 0.333. We need
    // collateral_ngn < 600,000 (= 1.20 × 500,000), so set SAT rate even lower.
    price_feed.getCurrentRate.mockResolvedValue({
      rate_buy: new Decimal('0.1'),    // 1.5M sat = ₦150,000 — well below alert floor
      rate_sell: new Decimal('0.095'),
    });
    prisma.loan.findMany.mockResolvedValue([make_loan()]);

    const result = await service.getSummary(USER_ID);

    const card = result.attention.find((c) => c.kind === 'LIQUIDATION_RISK');
    expect(card).toBeDefined();
    expect(card?.title).toBe('Add collateral or repay');
  });

  it('emits AWAITING_RELEASE_ADDRESS for REPAID loans without a release address', async () => {
    prisma.loan.findMany.mockResolvedValue([
      make_loan({ id: 'loan-repaid', status: LoanStatus.REPAID, collateral_release_address: null }),
    ]);

    const result = await service.getSummary(USER_ID);

    expect(result.attention).toHaveLength(1);
    expect(result.attention[0]).toMatchObject({
      loan_id: 'loan-repaid',
      kind: 'AWAITING_RELEASE_ADDRESS',
    });
    expect(result.attention[0].title).toContain('Lightning');
  });

  it('skips REPAID loans that already have a release address', async () => {
    prisma.loan.findMany.mockResolvedValue([
      make_loan({
        status: LoanStatus.REPAID,
        collateral_release_address: 'jeremy@blink.sv',
      }),
    ]);

    const result = await service.getSummary(USER_ID);

    expect(result.attention).toEqual([]);
  });

  it('sorts attention DESC by urgency: LIQUIDATION_RISK > PENDING > AWAITING', async () => {
    price_feed.getCurrentRate.mockResolvedValue({
      rate_buy: new Decimal('0.1'),
      rate_sell: new Decimal('0.095'),
    });
    prisma.loan.findMany.mockResolvedValue([
      make_loan({ id: 'loan-await', status: LoanStatus.REPAID, collateral_release_address: null }),
      make_loan({
        id: 'loan-pending',
        status: LoanStatus.PENDING_COLLATERAL,
        collateral_received_at: null,
      }),
      make_loan({ id: 'loan-active' }),
    ]);

    const result = await service.getSummary(USER_ID);

    // loan-active produces LIQUIDATION_RISK (low rate). First must be LIQUIDATION_RISK,
    // last must be AWAITING_RELEASE_ADDRESS.
    expect(result.attention[0].kind).toBe('LIQUIDATION_RISK');
    expect(result.attention[result.attention.length - 1].kind).toBe('AWAITING_RELEASE_ADDRESS');
    // Strict urgency ordering
    for (let i = 1; i < result.attention.length; i += 1) {
      expect(result.attention[i - 1].urgency).toBeGreaterThanOrEqual(result.attention[i].urgency);
    }
  });

  it('counts and sums unmatched inflows, gating untrusted reasons out', async () => {
    prisma.inflow.findMany.mockResolvedValue([
      { amount: { toString: () => '5000' }, provider_response: null },
      { amount: { toString: () => '15000' }, provider_response: { payerAccountName: 'Ada' } },
      // Untrusted — must NOT be counted (matches LoansService.listUnmatchedInflowsForUser)
      {
        amount: { toString: () => '1_000_000' },
        provider_response: { bitmonie_unmatched_reason: 'requery_mismatch' },
      },
      {
        amount: { toString: () => '2_000_000' },
        provider_response: { bitmonie_unmatched_reason: 'credit_failed' },
      },
    ]);

    const result = await service.getSummary(USER_ID);

    expect(result.unmatched_inflow_count).toBe(2);
    expect(result.unmatched_inflow_total_ngn).toBe('20000');
  });
});
