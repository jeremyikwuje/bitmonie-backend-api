import Decimal from 'decimal.js';
import { CalculatorService } from '@/modules/loans/calculator.service';
import {
  ALERT_THRESHOLD,
  CUSTODY_FEE_PER_100_USD_NGN,
  DAILY_INTEREST_RATE_BPS,
  LIQUIDATION_THRESHOLD,
  LOAN_LTV_PERCENT,
  ORIGINATION_FEE_PER_100K_NGN,
  SATS_PER_BTC,
} from '@/common/constants';

// ── Fixtures ──────────────────────────────────────────────────────────────────
//   principal      = N500,000
//   sat_ngn_rate   = N0.97            (≈ N97M / BTC — round for easy math)
//   btc_usd_rate   = $65,000          (Blink — BTC/USD direct quote)
//
// Derivations:
//   collateral_ngn         = 500_000 / 0.60 ≈ 833_333.33
//   collateral_sat         = ceil(833_333.33 / 0.97) = 859_107
//   initial_collateral_usd = (859_107 / 100_000_000) × 65_000 ≈ $558.4226
//   origination            = waived (0)
//   custody_units          = ceil(558.4226 / 100) = 6
//   daily_custody_fee_ngn  = 6 × 100 = 600
//   daily_interest_ngn     = 500_000 × 0.003 = 1,500

const PRINCIPAL    = new Decimal('500000');
const SAT_RATE     = new Decimal('0.97');
const BTC_USD_RATE = new Decimal('65000');

function calculate(overrides: Partial<{
  principal_ngn: Decimal;
  sat_ngn_rate:  Decimal;
  btc_usd_rate:  Decimal;
}> = {}) {
  return new CalculatorService().calculate({
    principal_ngn: overrides.principal_ngn ?? PRINCIPAL,
    sat_ngn_rate:  overrides.sat_ngn_rate  ?? SAT_RATE,
    btc_usd_rate:  overrides.btc_usd_rate  ?? BTC_USD_RATE,
  });
}

// ── Origination fee (currently waived — ORIGINATION_FEE_PER_100K_NGN = 0) ─────

describe('CalculatorService — origination fee', () => {
  it('is waived at every supported principal', () => {
    const principals = ['10000', '150000', '333000', '500000', '10000000'];
    for (const p of principals) {
      const result = calculate({ principal_ngn: new Decimal(p) });
      expect(result.origination_fee_ngn).toEqual(new Decimal('0'));
    }
  });

  it('still scales as ORIGINATION_FEE_PER_100K_NGN × ceil(principal / 100k)', () => {
    const result = calculate({ principal_ngn: new Decimal('333000') });
    expect(result.origination_fee_ngn).toEqual(ORIGINATION_FEE_PER_100K_NGN.mul(4));
  });
});

// ── Daily custody fee (fixed at origination, ceil per $100) ───────────────────

describe('CalculatorService — daily custody fee', () => {
  it('at $558.42 collateral → N600/day (6 × 100)', () => {
    expect(calculate().daily_custody_fee_ngn).toEqual(new Decimal('600'));
  });

  it('sub-$100 collateral still pays N100/day (ceil rule, no floor needed)', () => {
    // Tiny principal + high sat rate → tiny collateral in USD
    const result = calculate({
      principal_ngn: new Decimal('50000'),
      sat_ngn_rate:  new Decimal('100'),       // N100/sat → massive BTC price → tiny sat count
      btc_usd_rate:  new Decimal('1'),         // and tiny USD value
    });
    // collateral_ngn ≈ 83333.33, sat = ceil(833.33) = 834 sats, usd = (834 / 1e8) × 1 = 0.00000834
    // ceil(0.00000834 / 100) = 1 → N100
    expect(result.daily_custody_fee_ngn).toEqual(CUSTODY_FEE_PER_100_USD_NGN);
  });

  it('scales with initial_collateral_usd — double the USD rate → double the units (roughly)', () => {
    const low  = calculate({ btc_usd_rate: new Decimal('32500') });  // halves USD → $279.2
    const high = calculate({ btc_usd_rate: new Decimal('65000') });  // $558.4
    // low: ceil(279.2/100) = 3 → N300;  high: ceil(558.4/100) = 6 → N600
    expect(low.daily_custody_fee_ngn).toEqual(new Decimal('300'));
    expect(high.daily_custody_fee_ngn).toEqual(new Decimal('600'));
  });
});

// ── Daily interest (day-0 disclosure, drops piecewise as principal repays) ────

describe('CalculatorService — daily interest', () => {
  it('daily_interest_ngn = principal × 0.003 at day 0', () => {
    const result = calculate();
    // 500_000 × 0.003 = 1,500
    expect(result.daily_interest_ngn).toEqual(new Decimal('1500'));
  });

  it('scales linearly with principal', () => {
    const small = calculate({ principal_ngn: new Decimal('100000') });
    const large = calculate({ principal_ngn: new Decimal('500000') });
    expect(large.daily_interest_ngn).toEqual(small.daily_interest_ngn.mul(5));
  });

  it('daily_interest_rate_bps is the constant (30 = 0.3%)', () => {
    expect(calculate().daily_interest_rate_bps).toBe(DAILY_INTEREST_RATE_BPS);
  });
});

// ── Disclosure (net disbursement) ─────────────────────────────────────────────

describe('CalculatorService — disclosure', () => {
  it('amount_to_receive_ngn = principal − origination (origination currently 0)', () => {
    const result = calculate();
    expect(result.amount_to_receive_ngn).toEqual(PRINCIPAL);
  });
});

// ── Collateral sizing + initial USD ───────────────────────────────────────────

describe('CalculatorService — collateral sizing', () => {
  it('collateral_amount_sat covers principal at 60% LTV (ceiled to whole SATs)', () => {
    const result = calculate();
    const expected_ngn = PRINCIPAL.div(LOAN_LTV_PERCENT);
    const expected_sat = BigInt(expected_ngn.div(SAT_RATE).ceil().toFixed(0));
    expect(result.collateral_amount_sat).toBe(expected_sat);
  });

  it('collateral_amount_sat is always an integer (no fractional SATs)', () => {
    const result = calculate({ sat_ngn_rate: new Decimal('1.234567') });
    expect(typeof result.collateral_amount_sat).toBe('bigint');
  });

  it('initial_collateral_usd = (sat / SATS_PER_BTC) × btc_usd_rate', () => {
    const result = calculate();
    const expected = new Decimal(result.collateral_amount_sat.toString())
      .div(SATS_PER_BTC)
      .mul(BTC_USD_RATE);
    expect(result.initial_collateral_usd.toFixed(6)).toBe(expected.toFixed(6));
  });

  it('ltv_percent equals LOAN_LTV_PERCENT (60%)', () => {
    expect(calculate().ltv_percent).toEqual(LOAN_LTV_PERCENT);
  });

  it('sat_ngn_rate_at_creation equals the rate passed in', () => {
    expect(calculate().sat_ngn_rate_at_creation).toEqual(SAT_RATE);
  });
});

// ── Initial threshold rates (UI display only) ─────────────────────────────────

describe('CalculatorService — initial threshold rates', () => {
  it('initial_liquidation_rate_ngn = principal × 1.10 / collateral_sat', () => {
    const result = calculate();
    const expected = PRINCIPAL.mul(LIQUIDATION_THRESHOLD).div(
      new Decimal(result.collateral_amount_sat.toString()),
    );
    expect(result.initial_liquidation_rate_ngn.toFixed(6)).toBe(expected.toFixed(6));
  });

  it('initial_alert_rate_ngn = principal × 1.20 / collateral_sat', () => {
    const result = calculate();
    const expected = PRINCIPAL.mul(ALERT_THRESHOLD).div(
      new Decimal(result.collateral_amount_sat.toString()),
    );
    expect(result.initial_alert_rate_ngn.toFixed(6)).toBe(expected.toFixed(6));
  });

  it('initial_alert_rate_ngn > initial_liquidation_rate_ngn', () => {
    const result = calculate();
    expect(result.initial_alert_rate_ngn.gt(result.initial_liquidation_rate_ngn)).toBe(true);
  });
});

// ── Input validation ──────────────────────────────────────────────────────────

describe('CalculatorService — input validation', () => {
  it('throws LOAN_AMOUNT_TOO_LOW when principal < N10,000', () => {
    expect(() => calculate({ principal_ngn: new Decimal('9999') })).toThrow(
      expect.objectContaining({ code: 'LOAN_AMOUNT_TOO_LOW' }),
    );
  });

  it('throws LOAN_AMOUNT_TOO_HIGH when principal > N10,000,000', () => {
    expect(() => calculate({ principal_ngn: new Decimal('10000001') })).toThrow(
      expect.objectContaining({ code: 'LOAN_AMOUNT_TOO_HIGH' }),
    );
  });

  it('accepts principal exactly at MIN (N10,000)', () => {
    expect(() => calculate({ principal_ngn: new Decimal('10000') })).not.toThrow();
  });

  it('accepts principal exactly at MAX (N10,000,000)', () => {
    expect(() => calculate({ principal_ngn: new Decimal('10000000') })).not.toThrow();
  });

  it('throws PRICE_FEED_STALE when sat_ngn_rate is zero', () => {
    expect(() => calculate({ sat_ngn_rate: new Decimal('0') })).toThrow(
      expect.objectContaining({ code: 'PRICE_FEED_STALE' }),
    );
  });

  it('throws PRICE_FEED_STALE when btc_usd_rate is zero', () => {
    expect(() => calculate({ btc_usd_rate: new Decimal('0') })).toThrow(
      expect.objectContaining({ code: 'PRICE_FEED_STALE' }),
    );
  });
});
