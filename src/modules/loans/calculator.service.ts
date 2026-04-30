import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import {
  ALERT_THRESHOLD,
  CUSTODY_FEE_PER_100_USD_NGN,
  DAILY_INTEREST_RATE_BPS,
  LIQUIDATION_THRESHOLD,
  LOAN_LTV_PERCENT,
  MAX_LOAN_DURATION_DAYS,
  MAX_SELFSERVE_LOAN_NGN,
  MIN_LOAN_DURATION_DAYS,
  MIN_LOAN_NGN,
  ORIGINATION_FEE_PER_100K_NGN,
  SATS_PER_BTC,
} from '@/common/constants';
import {
  LoanAmountTooHighException,
  LoanAmountTooLowException,
  LoanDurationInvalidException,
  PriceFeedStaleException,
} from '@/common/errors/bitmonie.errors';

export interface CalculatorInput {
  principal_ngn: Decimal;
  duration_days: number;
  sat_ngn_rate: Decimal;      // Quidax — for collateral sizing in SAT
  btc_usd_rate: Decimal;      // Blink — for initial_collateral_usd derivation
}

export interface CalculatorResult {
  // Known at origination — stored on Loan
  principal_ngn:             Decimal;
  origination_fee_ngn:       Decimal;      // ceil(principal / 100k) × 500
  daily_custody_fee_ngn:     Decimal;      // ceil(initial_collateral_usd / 100) × 100; fixed for life of loan
  daily_interest_rate_bps:   number;       // 30 → 0.3%
  duration_days:             number;

  // Collateral sizing
  collateral_amount_sat:     bigint;
  initial_collateral_usd:    Decimal;      // pinned at origination from Blink quote
  ltv_percent:               Decimal;
  sat_ngn_rate_at_creation:  Decimal;

  // Projections for the chosen term (customer-facing estimates; actual values accrue)
  projected_interest_ngn:    Decimal;      // 0.003 × principal × duration
  projected_custody_ngn:     Decimal;      // daily_custody × duration
  projected_total_ngn:       Decimal;      // principal + origination + projected_interest + projected_custody

  // Disclosure (FCCPC / CBN consumer-protection — see docs/repayment-matching-redesign.md)
  amount_to_receive_ngn:        Decimal;   // principal − origination — what hits the customer's bank
  amount_to_repay_estimate_ngn: Decimal;   // principal + projected_interest + projected_custody
                                           // — what the customer pays back over the chosen term
                                           // (estimate; actual interest + custody accrue daily)

  // Display-only thresholds (UI shows "liquidation if BTC drops to X")
  // Not stored on Loan — liquidation monitor recomputes against live outstanding.
  initial_liquidation_rate_ngn: Decimal;
  initial_alert_rate_ngn:       Decimal;
}

const HUNDRED_K_NGN          = new Decimal('100000');
const USD_FEE_UNIT           = new Decimal('100');
const BPS_DENOMINATOR        = new Decimal('10000');

@Injectable()
export class CalculatorService {
  calculate(input: CalculatorInput): CalculatorResult {
    this._validate(input);

    const { principal_ngn, duration_days, sat_ngn_rate, btc_usd_rate } = input;

    // ── Collateral sizing ──────────────────────────────────────────────────
    // At 60% LTV: collateral_ngn = principal / 0.60.
    // collateral_sat = ceil(collateral_ngn / sat_ngn_rate) — favour the lender on fractional SATs.
    const collateral_ngn = principal_ngn.div(LOAN_LTV_PERCENT);
    const collateral_amount_sat = BigInt(collateral_ngn.div(sat_ngn_rate).ceil().toFixed(0));

    // ── USD equivalent of collateral (via Blink) ───────────────────────────
    // initial_collateral_usd = (collateral_sat / SATS_PER_BTC) × btc_usd_rate
    const initial_collateral_usd = new Decimal(collateral_amount_sat.toString())
      .div(SATS_PER_BTC)
      .mul(btc_usd_rate);

    // ── Origination fee (one-time) ─────────────────────────────────────────
    // ceil(principal / 100_000) × 500
    const origination_units = principal_ngn.div(HUNDRED_K_NGN).ceil();
    const origination_fee_ngn = origination_units.mul(ORIGINATION_FEE_PER_100K_NGN);

    // ── Daily custody fee (fixed at origination) ───────────────────────────
    // ceil(initial_collateral_usd / 100) × 100
    const custody_units = initial_collateral_usd.div(USD_FEE_UNIT).ceil();
    const daily_custody_fee_ngn = custody_units.mul(CUSTODY_FEE_PER_100_USD_NGN);

    // ── Projections (estimate for chosen duration — actual accrues daily) ──
    const interest_per_day = principal_ngn.mul(DAILY_INTEREST_RATE_BPS).div(BPS_DENOMINATOR);
    const projected_interest_ngn = interest_per_day.mul(duration_days);
    const projected_custody_ngn  = daily_custody_fee_ngn.mul(duration_days);
    const projected_total_ngn = principal_ngn
      .plus(origination_fee_ngn)
      .plus(projected_interest_ngn)
      .plus(projected_custody_ngn);

    // ── Disclosure (net disbursement + estimated repayment) ────────────────
    // amount_to_receive   = principal − origination (origination is netted at
    //                       disbursement; customer never pays it back).
    // amount_to_repay     = principal + projected_interest + projected_custody
    //                       — origination is NOT in this number; it was already
    //                       collected via the spread between disbursed and
    //                       repaid. Estimate only — interest/custody accrue daily.
    const amount_to_receive_ngn        = principal_ngn.minus(origination_fee_ngn);
    const amount_to_repay_estimate_ngn = principal_ngn
      .plus(projected_interest_ngn)
      .plus(projected_custody_ngn);

    // ── Display-only thresholds — based on principal alone at day 0 ────────
    const sat_decimal = new Decimal(collateral_amount_sat.toString());
    const initial_liquidation_rate_ngn = principal_ngn.mul(LIQUIDATION_THRESHOLD).div(sat_decimal);
    const initial_alert_rate_ngn       = principal_ngn.mul(ALERT_THRESHOLD).div(sat_decimal);

    return {
      principal_ngn,
      origination_fee_ngn,
      daily_custody_fee_ngn,
      daily_interest_rate_bps: DAILY_INTEREST_RATE_BPS,
      duration_days,

      collateral_amount_sat,
      initial_collateral_usd,
      ltv_percent: LOAN_LTV_PERCENT,
      sat_ngn_rate_at_creation: sat_ngn_rate,

      projected_interest_ngn,
      projected_custody_ngn,
      projected_total_ngn,

      amount_to_receive_ngn,
      amount_to_repay_estimate_ngn,

      initial_liquidation_rate_ngn,
      initial_alert_rate_ngn,
    };
  }

  private _validate(input: CalculatorInput): void {
    const { principal_ngn, duration_days, sat_ngn_rate, btc_usd_rate } = input;

    if (sat_ngn_rate.lte(0) || btc_usd_rate.lte(0)) {
      throw new PriceFeedStaleException({ last_updated_ms: 0 });
    }

    if (principal_ngn.lt(MIN_LOAN_NGN)) {
      throw new LoanAmountTooLowException({ minimum_ngn: MIN_LOAN_NGN.toFixed(0) });
    }

    if (principal_ngn.gt(MAX_SELFSERVE_LOAN_NGN)) {
      throw new LoanAmountTooHighException({ maximum_ngn: MAX_SELFSERVE_LOAN_NGN.toFixed(0) });
    }

    if (duration_days < MIN_LOAN_DURATION_DAYS || duration_days > MAX_LOAN_DURATION_DAYS) {
      throw new LoanDurationInvalidException({
        min: MIN_LOAN_DURATION_DAYS,
        max: MAX_LOAN_DURATION_DAYS,
      });
    }
  }
}
