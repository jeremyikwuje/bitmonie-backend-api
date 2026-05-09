import { Injectable } from '@nestjs/common';
import { AssetPair, LoanStatus } from '@prisma/client';
import Decimal from 'decimal.js';
import { PrismaService } from '@/database/prisma.service';
import { AccrualService, type AccrualRepaymentInput } from '@/modules/loans/accrual.service';
import { PriceFeedService } from '@/modules/price-feed/price-feed.service';
import { displayNgn } from '@/common/formatting/ngn-display';
import { ALERT_THRESHOLD, SATS_PER_BTC } from '@/common/constants';
import {
  type AttentionKind,
  type MeSummaryResponseDto,
  type AttentionCardDto,
} from './dto/me-summary-response.dto';

// ─────────────────────────────────────────────────────────────────────────────
// MeService — read-only aggregator for the web client's home shell.
// Returns: total outstanding across ACTIVE loans, attention cards (loans that
// need the user), and unmatched-inflow counts. Computed live; cached nowhere.
//
// Spec: ../../../docs/web.md §5.1.
// ─────────────────────────────────────────────────────────────────────────────

// Basis-points denominator for converting daily_interest_rate_bps → daily
// fraction. Mirrors the same private constant in AccrualService — fine to
// duplicate since 10_000 is the bps definition, not project-specific config.
const BPS_DENOMINATOR = new Decimal('10000');

// Stable urgency tiers — the spec only promises "sort DESC, no fixed range,"
// so future tiers can slot between these without breaking the contract.
const URGENCY: Record<AttentionKind, number> = {
  LIQUIDATION_RISK:         100,
  PENDING_COLLATERAL:        80,
  AWAITING_RELEASE_ADDRESS:  30,
};

// Matches LoansService.listUnmatchedInflowsForUser — these inflows are
// gated out of the customer surface (untrusted: provider re-query disagreed,
// credit attempt failed mid-flight, etc.) so we mirror the same filter here
// to avoid telling the customer about money they can't actually claim.
const UNTRUSTED_UNMATCHED_REASONS = new Set([
  'requery_mismatch',
  'requery_unconfirmed',
  'credit_failed',
]);

@Injectable()
export class MeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accrual: AccrualService,
    private readonly price_feed: PriceFeedService,
  ) {}

  async getSummary(user_id: string): Promise<MeSummaryResponseDto> {
    const as_of = new Date();

    // Loan-side load: only the statuses that can produce attention or contribute
    // to outstanding. EXPIRED / LIQUIDATED / CANCELLED are terminal and irrelevant.
    const loans = await this.prisma.loan.findMany({
      where: {
        user_id,
        status: { in: [LoanStatus.PENDING_COLLATERAL, LoanStatus.ACTIVE, LoanStatus.REPAID] },
      },
      include: { repayments: { orderBy: { created_at: 'asc' } } },
    });

    const active_loans = loans.filter((l) => l.status === LoanStatus.ACTIVE);
    const pending_loans = loans.filter((l) => l.status === LoanStatus.PENDING_COLLATERAL);
    const repaid_loans = loans.filter((l) => l.status === LoanStatus.REPAID);

    // ── outstanding sum + projected next-day accrual ─────────────────────────
    // daily_accrual_ngn is the total amount the user's outstanding will grow
    // by tomorrow if they take no action — interest + custody, summed across
    // every ACTIVE loan. Drives the "₦X accrues daily" urgency line on the
    // Home hero so the user feels the cost of waiting. Interest is computed
    // against current outstanding principal (post-repayments) — partial
    // repayments lower the daily interest. Custody is fixed at origination
    // and accrues regardless of repayments.
    let outstanding_total = new Decimal(0);
    let daily_accrual_total = new Decimal(0);
    const active_outstandings = new Map<string, Decimal>();
    for (const loan of active_loans) {
      const result = this.accrual.compute({
        loan,
        repayments: loan.repayments.map(toAccrualRepayment),
        as_of,
      });
      outstanding_total = outstanding_total.plus(result.total_outstanding_ngn);
      active_outstandings.set(loan.id, result.total_outstanding_ngn);

      // bps → fraction. Same shape AccrualService uses internally; kept here
      // so we don't have to expose a new method on AccrualService just for
      // this single per-day projection.
      const rate_factor = new Decimal(loan.daily_interest_rate_bps).div(BPS_DENOMINATOR);
      const daily_interest = result.principal_ngn.mul(rate_factor);
      const daily_custody = new Decimal(loan.daily_custody_fee_ngn.toString());
      daily_accrual_total = daily_accrual_total.plus(daily_interest).plus(daily_custody);
    }

    // ── attention cards ──────────────────────────────────────────────────────
    const attention: AttentionCardDto[] = [];

    // PENDING_COLLATERAL: pair each loan with its open PaymentRequest (for expiry).
    if (pending_loans.length > 0) {
      const pending_payment_requests = await this.prisma.paymentRequest.findMany({
        where: {
          source_type: 'LOAN',
          source_id: { in: pending_loans.map((l) => l.id) },
          status: 'PENDING',
        },
        select: { source_id: true, expires_at: true },
      });
      const expiry_by_loan = new Map(
        pending_payment_requests.map((pr) => [pr.source_id, pr.expires_at]),
      );

      for (const loan of pending_loans) {
        attention.push({
          loan_id: loan.id,
          kind: 'PENDING_COLLATERAL',
          urgency: URGENCY.PENDING_COLLATERAL,
          title: `Send ${formatSat(loan.collateral_amount_sat)} SAT`,
          subtitle: `Pay to start your ${formatNgn(new Decimal(loan.principal_ngn.toString()))} loan`,
          expires_at: expiry_by_loan.get(loan.id)?.toISOString(),
        });
      }
    }

    // ACTIVE → LIQUIDATION_RISK when collateral coverage drops below ALERT_THRESHOLD.
    // Loans are open-term in v1.2 — there's no due_at and no maturity overdue
    // state to surface; the only ACTIVE-loan attention path is coverage-driven.
    if (active_loans.length > 0) {
      // SAT/NGN buy rate: what we'd pay to buy back SAT, the conservative side
      // for liquidation evaluation (matches calculator.service initial_alert_rate).
      // If the feed is stale, getCurrentRate throws — we let that propagate;
      // the client can retry. Better than silently omitting LIQUIDATION_RISK cards.
      const sat_ngn = await this.price_feed.getCurrentRate(AssetPair.SAT_NGN);

      for (const loan of active_loans) {
        // LIQUIDATION_RISK — collateral_ngn < ALERT_THRESHOLD × outstanding
        const outstanding = active_outstandings.get(loan.id);
        if (!outstanding || outstanding.lte(0)) continue;

        const collateral_ngn = new Decimal(loan.collateral_amount_sat.toString())
          .mul(sat_ngn.rate_buy)
          .div(SATS_PER_BTC);
        const alert_floor = outstanding.mul(ALERT_THRESHOLD);
        if (collateral_ngn.lt(alert_floor)) {
          attention.push({
            loan_id: loan.id,
            kind: 'LIQUIDATION_RISK',
            urgency: URGENCY.LIQUIDATION_RISK,
            title: 'Add collateral or repay',
            subtitle: 'Bitcoin price has dropped — your loan is at risk of liquidation',
          });
        }
      }
    }

    // REPAID with no release address → AWAITING_RELEASE_ADDRESS.
    // If the user already supplied one, the worker handles the rest; nothing
    // to surface here. (Once `collateral_released_at` is set, the loan still
    // shows up in this query but has an address, so we don't emit a card.)
    for (const loan of repaid_loans) {
      if (loan.collateral_release_address === null) {
        attention.push({
          loan_id: loan.id,
          kind: 'AWAITING_RELEASE_ADDRESS',
          urgency: URGENCY.AWAITING_RELEASE_ADDRESS,
          title: 'Set a Lightning address',
          subtitle: `Get your ${formatSat(loan.collateral_amount_sat)} SAT collateral back`,
        });
      }
    }

    // Sort: urgency DESC, then expires_at ASC (sooner deadline first within tier).
    attention.sort((a, b) => {
      if (b.urgency !== a.urgency) return b.urgency - a.urgency;
      const a_exp = a.expires_at ? Date.parse(a.expires_at) : Number.POSITIVE_INFINITY;
      const b_exp = b.expires_at ? Date.parse(b.expires_at) : Number.POSITIVE_INFINITY;
      return a_exp - b_exp;
    });

    // ── unmatched inflows ────────────────────────────────────────────────────
    // Same filter as LoansService.listUnmatchedInflowsForUser so the count
    // matches what the user will actually see when they tap into /inflows.
    const unmatched_rows = await this.prisma.inflow.findMany({
      where: { user_id, currency: 'NGN', is_matched: false, source_type: null },
      select: { amount: true, provider_response: true },
    });
    let unmatched_count = 0;
    let unmatched_total = new Decimal(0);
    for (const row of unmatched_rows) {
      const reason = (row.provider_response as { bitmonie_unmatched_reason?: string } | null)
        ?.bitmonie_unmatched_reason;
      if (reason && UNTRUSTED_UNMATCHED_REASONS.has(reason)) continue;
      unmatched_count += 1;
      unmatched_total = unmatched_total.plus(new Decimal(row.amount.toString()));
    }

    return {
      outstanding_ngn: displayNgn(outstanding_total, 'ceil'),
      daily_accrual_ngn: displayNgn(daily_accrual_total, 'ceil'),
      active_loan_count: active_loans.length,
      attention,
      unmatched_inflow_count: unmatched_count,
      unmatched_inflow_total_ngn: displayNgn(unmatched_total, 'ceil'),
    };
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function toAccrualRepayment(r: {
  applied_to_principal: { toString: () => string };
  applied_to_interest: { toString: () => string };
  applied_to_custody: { toString: () => string };
  created_at: Date;
}): AccrualRepaymentInput {
  return {
    applied_to_principal: new Decimal(r.applied_to_principal.toString()),
    applied_to_interest: new Decimal(r.applied_to_interest.toString()),
    applied_to_custody: new Decimal(r.applied_to_custody.toString()),
    created_at: r.created_at,
  };
}

function formatNgn(amount: Decimal): string {
  // Customer-facing display: "₦525,000" — server owns the copy on attention
  // cards so the tone matches reminder emails. Render via displayNgn(ceil) so
  // the fractional kobo doesn't leak into a user-facing string.
  const whole = displayNgn(amount, 'ceil');
  const with_commas = Number(whole).toLocaleString('en-NG');
  return `₦${with_commas}`;
}

function formatSat(amount_sat: bigint): string {
  return amount_sat.toLocaleString('en-US');
}
