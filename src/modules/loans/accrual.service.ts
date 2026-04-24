import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

// ─────────────────────────────────────────────────────────────────────────────
// AccrualService — pure function. No DB, no clock, deterministic.
// Source of truth for "how much does this loan owe right now."
// Used by: liquidation monitor, GET /v1/loans/:id, repayment waterfall.
// See docs/repayment-matching-redesign.md §3.
// ─────────────────────────────────────────────────────────────────────────────

export interface AccrualLoanInput {
  principal_ngn:           Decimal;
  daily_interest_rate_bps: number;
  daily_custody_fee_ngn:   Decimal;
  collateral_received_at:  Date | null;      // accrual starts here; null → loan never activated
}

export interface AccrualRepaymentInput {
  applied_to_principal: Decimal;
  applied_to_interest:  Decimal;
  applied_to_custody:   Decimal;
  created_at:           Date;
}

export interface Outstanding {
  principal_ngn:         Decimal;       // outstanding principal (after repayments)
  accrued_interest_ngn:  Decimal;       // unpaid interest
  accrued_custody_ngn:   Decimal;       // unpaid custody
  total_outstanding_ngn: Decimal;       // sum of the three
  days_elapsed:          number;        // ceil of (as_of − collateral_received_at) in days
  as_of:                 Date;
}

const MS_PER_DAY      = 86_400_000;
const BPS_DENOMINATOR = new Decimal('10000');

/**
 * Day-boundary rule: elapsed time rounds UP to 24h buckets.
 *   days(t, t)           = 0
 *   days(t, t + 1 ms)    = 1
 *   days(t, t + 24h)     = 1
 *   days(t, t + 24h+1ms) = 2
 * So a repayment 2h after origination still incurs 1 day of fees.
 */
function ceilDays(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  if (ms <= 0) return 0;
  return Math.ceil(ms / MS_PER_DAY);
}

@Injectable()
export class AccrualService {
  compute(params: {
    loan: AccrualLoanInput;
    repayments: AccrualRepaymentInput[];
    as_of: Date;
  }): Outstanding {
    const { loan, repayments, as_of } = params;

    // Loan never activated — nothing has accrued.
    if (!loan.collateral_received_at) {
      return {
        principal_ngn:         loan.principal_ngn,
        accrued_interest_ngn:  new Decimal(0),
        accrued_custody_ngn:   new Decimal(0),
        total_outstanding_ngn: loan.principal_ngn,
        days_elapsed:          0,
        as_of,
      };
    }

    const final_day = ceilDays(loan.collateral_received_at, as_of);

    // Only count repayments that landed by `as_of`.
    const relevant = repayments
      .filter((r) => r.created_at.getTime() <= as_of.getTime())
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

    // ── Interest: piecewise constant principal ─────────────────────────────
    // Walk segments; each repayment drops the principal from that day forward.
    let current_principal = loan.principal_ngn;
    let cur_day           = 0;
    let gross_interest    = new Decimal(0);

    const rate_factor = new Decimal(loan.daily_interest_rate_bps).div(BPS_DENOMINATOR);

    for (const rep of relevant) {
      const rep_day_raw = ceilDays(loan.collateral_received_at, rep.created_at);
      const rep_day = Math.min(rep_day_raw, final_day);

      const segment_days = rep_day - cur_day;
      if (segment_days > 0) {
        gross_interest = gross_interest.plus(
          current_principal.mul(rate_factor).mul(segment_days),
        );
      }

      cur_day = rep_day;
      current_principal = current_principal.minus(rep.applied_to_principal);

      if (cur_day >= final_day) break;
    }

    // Tail: current_principal applies from cur_day → final_day
    if (cur_day < final_day) {
      const tail_days = final_day - cur_day;
      gross_interest = gross_interest.plus(
        current_principal.mul(rate_factor).mul(tail_days),
      );
    }

    // ── Sum paid amounts across all relevant repayments ────────────────────
    const paid_principal = relevant.reduce(
      (sum, r) => sum.plus(r.applied_to_principal),
      new Decimal(0),
    );
    const paid_interest = relevant.reduce(
      (sum, r) => sum.plus(r.applied_to_interest),
      new Decimal(0),
    );
    const paid_custody = relevant.reduce(
      (sum, r) => sum.plus(r.applied_to_custody),
      new Decimal(0),
    );

    // ── Outstanding = gross accrued minus what's been paid (floored at 0) ──
    const gross_custody         = loan.daily_custody_fee_ngn.mul(final_day);
    const outstanding_principal = Decimal.max(loan.principal_ngn.minus(paid_principal), new Decimal(0));
    const outstanding_interest  = Decimal.max(gross_interest.minus(paid_interest), new Decimal(0));
    const outstanding_custody   = Decimal.max(gross_custody.minus(paid_custody), new Decimal(0));

    return {
      principal_ngn:         outstanding_principal,
      accrued_interest_ngn:  outstanding_interest,
      accrued_custody_ngn:   outstanding_custody,
      total_outstanding_ngn: outstanding_principal
        .plus(outstanding_interest)
        .plus(outstanding_custody),
      days_elapsed: final_day,
      as_of,
    };
  }
}
