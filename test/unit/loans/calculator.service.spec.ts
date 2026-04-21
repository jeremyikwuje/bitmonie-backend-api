import Decimal from 'decimal.js';
import { CalculatorService } from '@/modules/loans/calculator.service';
import {
  LOAN_LTV_PERCENT,
  ORIGINATION_FEE_NGN,
  DAILY_FEE_PER_100_NGN,
  LIQUIDATION_THRESHOLD,
  ALERT_THRESHOLD,
} from '@/common/constants';

// ── Fixtures ──────────────────────────────────────────────────────────────────
// Concrete numbers derived from the TDD example, plus a SAT rate.
//
//   principal     = N300,000
//   duration      = 7 days
//   usdt_ngn_rate = N1,410
//   sat_ngn_rate  = N0.97   (≈ N97,000,000 / BTC — round number for easy maths)

const PRINCIPAL    = new Decimal('300000');
const DURATION     = 7;
const USDT_RATE    = new Decimal('1410');
const SAT_RATE     = new Decimal('0.97');

function calculate(overrides: Partial<{
  principal_ngn: Decimal;
  duration_days: number;
  sat_ngn_rate: Decimal;
  usdt_ngn_rate: Decimal;
}> = {}) {
  return new CalculatorService().calculate({
    principal_ngn:  overrides.principal_ngn  ?? PRINCIPAL,
    duration_days:  overrides.duration_days  ?? DURATION,
    sat_ngn_rate:   overrides.sat_ngn_rate   ?? SAT_RATE,
    usdt_ngn_rate:  overrides.usdt_ngn_rate  ?? USDT_RATE,
  });
}

// ── Fee arithmetic ────────────────────────────────────────────────────────────

describe('CalculatorService — fee arithmetic', () => {
  it('matches the TDD worked example: N300k / 7d @ N1,410/USDT → total fees N11,000', () => {
    const result = calculate();
    //   usd_equivalent = 300000 / 1410 ≈ 212.77
    //   fee_units      = ceil(212.77 / 100) = 3
    //   daily_fee_ngn  = 3 * 500 = 1500
    //   total_fees     = (1500 * 7) + 500 = 11000
    expect(result.total_fees_ngn).toEqual(new Decimal('11000'));
  });

  it('daily_fee_ngn equals fee_units * DAILY_FEE_PER_100_NGN', () => {
    const result = calculate();
    // 3 units × N500
    expect(result.daily_fee_ngn).toEqual(DAILY_FEE_PER_100_NGN.mul(3));
  });

  it('origination fee is always ORIGINATION_FEE_NGN (N500) regardless of loan size', () => {
    const small = calculate({ principal_ngn: new Decimal('50000') });
    const large = calculate({ principal_ngn: new Decimal('5000000') });
    expect(small.origination_fee_ngn).toEqual(ORIGINATION_FEE_NGN);
    expect(large.origination_fee_ngn).toEqual(ORIGINATION_FEE_NGN);
  });

  it('total_amount_ngn = principal + total_fees_ngn', () => {
    const result = calculate();
    expect(result.total_amount_ngn).toEqual(PRINCIPAL.plus(result.total_fees_ngn));
  });

  it('uses ceil for partial $100 USD units — N50,000 / N1,410 ≈ $35.46 → 1 unit', () => {
    const result = calculate({ principal_ngn: new Decimal('50000') });
    // usd = 50000 / 1410 ≈ 35.46 → ceil(0.35) = 1 unit
    expect(result.daily_fee_ngn).toEqual(DAILY_FEE_PER_100_NGN.mul(1));
  });

  it('fee scales correctly with duration', () => {
    const one_day  = calculate({ duration_days: 1 });
    const ten_days = calculate({ duration_days: 10 });
    const diff = ten_days.total_fees_ngn.minus(one_day.total_fees_ngn);
    // both have the same daily_fee, so difference should be 9 × daily_fee
    expect(diff).toEqual(one_day.daily_fee_ngn.mul(9));
  });

  it('produces no floating-point rounding errors', () => {
    // Deliberately awkward USDT rate
    const result = calculate({ usdt_ngn_rate: new Decimal('1399.99') });
    // Verify the result is a valid Decimal with no rounding artifacts
    expect(() => result.total_fees_ngn.toFixed(2)).not.toThrow();
    expect(result.total_fees_ngn.decimalPlaces()).toBeLessThanOrEqual(2);
  });
});

// ── LTV and collateral ────────────────────────────────────────────────────────

describe('CalculatorService — LTV and collateral', () => {
  it('ltv_percent equals LOAN_LTV_PERCENT (80%)', () => {
    expect(calculate().ltv_percent).toEqual(LOAN_LTV_PERCENT);
  });

  it('collateral_amount_sat covers the loan at 80% LTV (ceiled to whole SATs)', () => {
    const result = calculate();
    // collateral_ngn = 300000 / 0.80 = 375000
    // collateral_sat = ceil(375000 / 0.97) = ceil(386597.938...) = 386598
    const collateral_ngn = PRINCIPAL.div(LOAN_LTV_PERCENT);
    const expected_sat = BigInt(collateral_ngn.div(SAT_RATE).ceil().toFixed(0));
    expect(result.collateral_amount_sat).toBe(expected_sat);
  });

  it('collateral_amount_sat is always an integer (no fractional SATs)', () => {
    const result = calculate({ sat_ngn_rate: new Decimal('1.234567') });
    expect(typeof result.collateral_amount_sat).toBe('bigint');
  });

  it('sat_ngn_rate_at_creation equals the rate passed in', () => {
    expect(calculate().sat_ngn_rate_at_creation).toEqual(SAT_RATE);
  });
});

// ── Liquidation and alert rates ───────────────────────────────────────────────

describe('CalculatorService — liquidation and alert rates', () => {
  it('liquidation_rate_ngn = principal × 1.10 / collateral_sat', () => {
    const result = calculate();
    const expected = PRINCIPAL.mul(LIQUIDATION_THRESHOLD).div(
      new Decimal(result.collateral_amount_sat.toString()),
    );
    expect(result.liquidation_rate_ngn.toFixed(6)).toBe(expected.toFixed(6));
  });

  it('alert_rate_ngn = principal × 1.20 / collateral_sat', () => {
    const result = calculate();
    const expected = PRINCIPAL.mul(ALERT_THRESHOLD).div(
      new Decimal(result.collateral_amount_sat.toString()),
    );
    expect(result.alert_rate_ngn.toFixed(6)).toBe(expected.toFixed(6));
  });

  it('alert_rate_ngn > liquidation_rate_ngn', () => {
    const result = calculate();
    expect(result.alert_rate_ngn.greaterThan(result.liquidation_rate_ngn)).toBe(true);
  });

  it('at the liquidation rate, collateral value is exactly 110% of principal', () => {
    const result = calculate();
    const collateral_value = result.liquidation_rate_ngn.mul(
      new Decimal(result.collateral_amount_sat.toString()),
    );
    // collateral_value / principal should equal 1.10
    const ratio = collateral_value.div(PRINCIPAL);
    expect(ratio.toFixed(4)).toBe(LIQUIDATION_THRESHOLD.toFixed(4));
  });
});

// ── Input validation ──────────────────────────────────────────────────────────

describe('CalculatorService — input validation', () => {
  it('throws LOAN_AMOUNT_TOO_LOW when principal < N50,000', () => {
    expect(() => calculate({ principal_ngn: new Decimal('49999') })).toThrow(
      expect.objectContaining({ code: 'LOAN_AMOUNT_TOO_LOW' }),
    );
  });

  it('throws LOAN_AMOUNT_TOO_HIGH when principal > N10,000,000', () => {
    expect(() => calculate({ principal_ngn: new Decimal('10000001') })).toThrow(
      expect.objectContaining({ code: 'LOAN_AMOUNT_TOO_HIGH' }),
    );
  });

  it('accepts principal exactly at MIN (N50,000)', () => {
    expect(() => calculate({ principal_ngn: new Decimal('50000') })).not.toThrow();
  });

  it('accepts principal exactly at MAX (N10,000,000)', () => {
    expect(() => calculate({ principal_ngn: new Decimal('10000000') })).not.toThrow();
  });

  it('throws LOAN_DURATION_INVALID when duration_days < 1', () => {
    expect(() => calculate({ duration_days: 0 })).toThrow(
      expect.objectContaining({ code: 'LOAN_DURATION_INVALID' }),
    );
  });

  it('throws LOAN_DURATION_INVALID when duration_days > 30', () => {
    expect(() => calculate({ duration_days: 31 })).toThrow(
      expect.objectContaining({ code: 'LOAN_DURATION_INVALID' }),
    );
  });

  it('accepts duration exactly at MIN (1 day)', () => {
    expect(() => calculate({ duration_days: 1 })).not.toThrow();
  });

  it('accepts duration exactly at MAX (30 days)', () => {
    expect(() => calculate({ duration_days: 30 })).not.toThrow();
  });

  it('throws LOAN_PRICE_STALE when sat_ngn_rate is zero', () => {
    expect(() => calculate({ sat_ngn_rate: new Decimal('0') })).toThrow(
      expect.objectContaining({ code: 'LOAN_PRICE_STALE' }),
    );
  });

  it('throws LOAN_PRICE_STALE when usdt_ngn_rate is zero', () => {
    expect(() => calculate({ usdt_ngn_rate: new Decimal('0') })).toThrow(
      expect.objectContaining({ code: 'LOAN_PRICE_STALE' }),
    );
  });
});
