import Decimal from 'decimal.js';

// ─────────────────────────────────────────────────────────────────────────────
// NGN display formatter — DISPLAY BOUNDARY ONLY.
//
// Customers see whole naira, never kobo. Internal math (AccrualService,
// CalculatorService, repayment waterfall, Inflow.amount, every Prisma
// `@db.Decimal(20, 8)` column) stays exact `Decimal` — sub-naira fractions
// flow through untouched and accrue correctly.
//
//   'ceil'  — round UP. Amounts the customer pays us. Paying the displayed
//             figure always fully covers what's owed; the at-most-1-naira
//             excess flows to `overpay_ngn` per the standard waterfall.
//             Use for: outstanding totals, projected fees/interest/custody,
//             repay estimates, principal remaining, applied-to-X breakdowns,
//             amount-paid receipts, calculator principal echo.
//
//   'floor' — round DOWN. Amounts we pay the customer. We never promise more
//             than we'll actually send.
//             Use for: amount_to_receive_ngn (disbursement), overpay refund.
//
// Rates / price feeds keep their decimals (toFixed(6)). Do NOT use this
// helper for sat_ngn rates, liquidation/alert rates, USD figures, percents.
// ─────────────────────────────────────────────────────────────────────────────

export function displayNgn(amount: Decimal | string | number, mode: 'ceil' | 'floor'): string {
  const d = amount instanceof Decimal ? amount : new Decimal(amount);
  const rounded = mode === 'ceil' ? d.ceil() : d.floor();
  return rounded.toFixed(0);
}
