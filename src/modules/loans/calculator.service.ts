import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import {
  LOAN_LTV_PERCENT,
  ORIGINATION_FEE_NGN,
  DAILY_FEE_PER_100_NGN,
  LIQUIDATION_THRESHOLD,
  ALERT_THRESHOLD,
  MIN_LOAN_NGN,
  MAX_SELFSERVE_LOAN_NGN,
  MIN_LOAN_DURATION_DAYS,
  MAX_LOAN_DURATION_DAYS,
} from '@/common/constants';
import {
  LoanAmountTooLowException,
  LoanAmountTooHighException,
  LoanDurationInvalidException,
  LoanPriceStaleException,
} from '@/common/errors/bitmonie.errors';

export interface CalculatorInput {
  principal_ngn: Decimal;
  duration_days: number;
  sat_ngn_rate: Decimal;    // current SAT/NGN rate — used for collateral sizing
  usdt_ngn_rate: Decimal;   // current USDT/NGN rate — used for USD-equivalent fee calc
}

export interface CalculatorResult {
  collateral_amount_sat: bigint;
  ltv_percent: Decimal;
  sat_ngn_rate_at_creation: Decimal;

  origination_fee_ngn: Decimal;
  daily_fee_ngn: Decimal;
  total_fees_ngn: Decimal;
  total_amount_ngn: Decimal;

  liquidation_rate_ngn: Decimal;   // SAT/NGN rate at which the loan is force-liquidated
  alert_rate_ngn: Decimal;         // SAT/NGN rate at which the customer is warned
}

// Fee is N500 per $100 USD equivalent per day.
// USD equivalent = principal_ngn / usdt_ngn_rate.
// Partial $100 unit billed as a full unit (ceil).
const USD_FEE_UNIT = new Decimal('100');

@Injectable()
export class CalculatorService {
  calculate(input: CalculatorInput): CalculatorResult {
    this.validate(input);

    const { principal_ngn, duration_days, sat_ngn_rate, usdt_ngn_rate } = input;

    // ── Collateral ──────────────────────────────────────────────────────────
    // At 80% LTV: collateral must be worth principal / LTV at today's rate.
    const collateral_ngn = principal_ngn.div(LOAN_LTV_PERCENT);
    // Ceil to whole satoshis — always favour the lender on fractional SATs.
    const collateral_amount_sat = BigInt(collateral_ngn.div(sat_ngn_rate).ceil().toFixed(0));

    // ── Fee calculation ─────────────────────────────────────────────────────
    // N500 per $100 USD equivalent per day; partial unit = full unit.
    const usd_equivalent = principal_ngn.div(usdt_ngn_rate);
    const fee_units = usd_equivalent.div(USD_FEE_UNIT).ceil();
    const daily_fee_ngn = fee_units.mul(DAILY_FEE_PER_100_NGN);
    const total_fees_ngn = daily_fee_ngn.mul(duration_days).plus(ORIGINATION_FEE_NGN);
    const total_amount_ngn = principal_ngn.plus(total_fees_ngn);

    // ── Liquidation / alert thresholds ──────────────────────────────────────
    // The rate at which collateral_sat × rate = principal × threshold.
    const sat_decimal = new Decimal(collateral_amount_sat.toString());
    const liquidation_rate_ngn = principal_ngn.mul(LIQUIDATION_THRESHOLD).div(sat_decimal);
    const alert_rate_ngn = principal_ngn.mul(ALERT_THRESHOLD).div(sat_decimal);

    return {
      collateral_amount_sat,
      ltv_percent: LOAN_LTV_PERCENT,
      sat_ngn_rate_at_creation: sat_ngn_rate,
      origination_fee_ngn: ORIGINATION_FEE_NGN,
      daily_fee_ngn,
      total_fees_ngn,
      total_amount_ngn,
      liquidation_rate_ngn,
      alert_rate_ngn,
    };
  }

  private validate(input: CalculatorInput): void {
    const { principal_ngn, duration_days, sat_ngn_rate, usdt_ngn_rate } = input;

    if (sat_ngn_rate.lte(0) || usdt_ngn_rate.lte(0)) {
      throw new LoanPriceStaleException({ last_updated_ms: 0 });
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
