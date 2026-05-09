# Loans v1.2 — No Duration, Margin-Call Safety, Pure Accrual Pricing

Status: **implemented 2026-05-08**. Migration `20260508000000_remove_loan_duration_due_at`. Supersedes the earlier two-cohort sketch in this same file.

> On lock, this overrides CLAUDE.md §2 (scope), §5.4 / §5.4a (state machine + maturity references), §6 (state machine table), §9 (constants), and §10 (calculator UX). Those files update alongside implementation, not in this doc.

---

## 0. Why this exists

We considered three loan-protection models:

1. **Margin model (status quo)** — LTV liquidation at 1.10 always. Safe for Bitmonie, harsh customer experience (sudden sales).
2. **Mortgage model (rejected)** — no LTV liquidation during a fixed term, only post-maturity. Strategic-default math kills it: a single 50% BTC drawdown during a 30-day term costs Bitmonie ~30% of principal per affected loan, and 30%+ drawdowns happen multiple times per cycle. Modeled in chat 2026-05-08.
3. **Margin-call model (chosen)** — LTV liquidation at 1.10 stays, but customers get structured warning + a top-up window before it triggers. Industry standard for BTC-backed lending (Ledn, Unchained, Nexo).

Once (3) is the safety mechanism, **duration is decorative** — it served only as a forced-close alternative we no longer need. So duration goes away entirely. Single-cohort product: amount in, BTC in, NGN out, repay anytime, accrual + LTV-margin-call govern everything.

The accrual itself self-terminates loans: at 0.3%/day interest + fixed daily custody, outstanding catches up to collateral around day 200 even at flat BTC, triggering LTV liquidation. So there's no infinite-open-position problem — the economics force resolution. This is surfaced in customer copy, not as a hidden surprise.

Explicitly **not** in this design: in-place loan modification, refinancing, term extensions, term-based pricing tiers, uncollateralized loans against wallet history (separate v1.3 conversation).

---

## 1. Locked decisions (pending sign-off)

| # | Decision |
|---|---|
| 1 | Loan duration is **removed entirely**. No `due_at`, no `term_days`, no checkout term picker. |
| 2 | Single product: customer enters principal amount, sends collateral via Lightning, NGN disburses to default account. Repay anytime via permanent VA. |
| 3 | **LTV liquidation at coverage `< 1.10` is the only forced-close path.** Applies always, instantly, no grace. |
| 4 | **Three coverage tiers govern customer notifications:** WARN at `< 1.20` (informational), MARGIN_CALL at `< 1.15` (urgent top-up notice — act immediately), LIQUIDATE at `< 1.10` (auto-execute). |
| 5 | **No time guarantee on margin call.** Customer copy is direct: "top up or repay immediately — we liquidate at 110% coverage." Bitmonie does not absorb fast-decline risk by holding liquidation. The notice is a courtesy heads-up, not a contractual window. |
| 6 | **Recovery-aware dedupe.** Each tier's notification fires once per crossing. When coverage rises back above a tier (top-up or repayment), the dedupe clears so a future re-deterioration re-notifies. |
| 7 | **Calculator returns daily rates only.** No term input, no projected total, no "if held 30 days" preview. Output: `origination_fee_ngn`, `daily_interest_ngn`, `daily_custody_fee_ngn`, plus collateral + liquidation-price math. |
| 8 | **Self-termination via accrual is surfaced in checkout copy.** "Daily charges accrue. Even if BTC stays flat, your loan will eventually reach the liquidation line — at current rates, that's roughly day 200 from disbursement." |
| 9 | Margin-call notification does **not** create a loan status row. Loan stays ACTIVE. Email-out + structured log is sufficient — no new self-transition reason code, no new status-log entry. |
| 10 | All other loan rules unchanged: liquidation math (§5.4a), repayment waterfall, partial repayments, add-collateral, collateral release, partial unique index on `PENDING_COLLATERAL` per user, 30-min `INVOICE_EXPIRED` for collateral-payment window (separate concern from loan duration — kept). |

---

## 2. Open questions (resolve before implementation)

1. **Customer notification channel for WARN + MARGIN_CALL.** Email-only via the existing `EmailProvider` interface (matches OTP/auth + ops-alert plumbing) is the smallest viable surface. Push-notification + in-product banner are deferred to v1.3.
2. **UI label on checkout.** Without a term picker, what does the principal-input screen call this? "Borrow Naira", "Get a loan", "Cash now"? Affects landing-page conversion copy more than backend.
3. **Calculator preview button.** Stripped to pure daily rates per decision #7. Confirming you don't want even a "see total cost if held 30 days" disclosure — only the daily rates and the self-termination note in checkout copy.
4. **Migration approach.** Drain existing loans naturally — wait until every legacy loan with a non-null `due_at` reaches a terminal state, then drop the workers and columns — with a feature-flagged dual-run, OR immediate cutover with a one-time customer email explaining the change. See §4.9.

---

## 3. PRD amendment (product surface)

### 3.1 Checkout

`POST /v1/loans/checkout` request body:
```typescript
{
  principal_ngn: number;
  disbursement_account_id: string;
  // term_days REMOVED
}
```

UI:
```
How much Naira do you want to borrow?
[ ₦__________ ]

Your collateral: 0.0667 BTC (~₦10,000,000)
Daily interest:  ₦18,000
Daily custody:   ₦6,700
Origination fee: ₦30,000 (one-time)

Repay anytime. Daily charges accrue until you repay.
At current rates, your loan reaches the liquidation line around day 200 if BTC stays flat — sooner if BTC declines.
```

The self-termination disclosure is non-negotiable. Customers should never be surprised that "no duration" doesn't mean "free to ignore."

### 3.2 Loan lifecycle (single model)

| Stage | Trigger | What customer sees |
|---|---|---|
| Checkout | Customer submits principal | Lightning invoice for collateral, 30-min expiry |
| Active | Collateral webhook confirms | NGN disbursed; loan view shows outstanding + coverage ratio |
| Active (margin warning) | Coverage drops `< 1.20` | Email: "Your collateral coverage is dropping. Consider topping up or repaying." |
| Active (margin call) | Coverage drops `< 1.15` | Email: "Margin call. Top up or repay immediately — we liquidate at 110% coverage." |
| Repaid | Customer repays full outstanding | Email: "Loan repaid. Set your release address to receive your BTC." |
| Liquidated | Coverage `< 1.10` | Email: "Your loan was liquidated to protect against further loss." |

There is no `EXPIRED` end state for the loan itself; `EXPIRED` only applies to PENDING_COLLATERAL when the 30-min invoice window passes.

### 3.3 Calculator

`POST /v1/calculator/quote` accepts `{ principal_ngn }`. Returns:
```json
{
  "principal_ngn": "6000000",
  "origination_fee_ngn": "30000",
  "daily_interest_ngn": "18000",
  "daily_custody_fee_ngn": "6700",
  "collateral_amount_sat": "6666667",
  "collateral_amount_ngn": "10000000",
  "liquidation_btc_price_ngn": "..."
}
```

No `term_days` input. No `projected_*` output. The page renders the two daily lines clearly so the customer can do the multiplication themselves and form realistic expectations.

### 3.4 Loan detail (`GET /v1/loans/:id`)

Removed: `due_at`, `term_days`, `days_remaining`.
Added: `coverage_ratio` (Decimal string, e.g. `"1.2843"`), `days_active` (since `collateral_received_at`), `accrual_summary` (`{ accrued_interest_ngn, accrued_custody_ngn, principal_remaining_ngn, outstanding_total_ngn }`).
Margin-call state: `margin_call_active: boolean` (true iff Redis dedupe key for MARGIN_CALL tier is set).

### 3.5 Margin call UX flow

1. Coverage crosses below 1.20 → WARN email fires once. Email links to `loan/:id` detail.
2. Coverage crosses below 1.15 → MARGIN_CALL email fires once. Direct urgency copy ("top up or repay immediately — we liquidate at 110%") with CTAs to `Add Collateral` or `Repay`. No promised window.
3. Customer top-up via existing `POST /v1/loans/:id/add-collateral` flow. On match, coverage rises; if it crosses back above 1.15, MARGIN_CALL Redis key clears (recovery). If it crosses back above 1.20, WARN clears too.
4. Coverage drops to `< 1.10` at any point → auto-liquidation immediately. No grace.

---

## 4. TDD amendment (technical surface)

### 4.1 Schema deltas

`Loan`:
- **DROP** `term_days INT` and `due_at TIMESTAMPTZ`. Existing rows lose these columns; values were not consumed by anything that survives this redesign.
- **No new columns.** Margin-call state lives in Redis; surfacing it in API responses uses Redis reads. Margin-call event log is a structured pino log line, not a DB row.

No changes to `LoanRepayment`, `CollateralTopUp`, `UserRepaymentAccount`, `loan_status_logs`.

Indexes: existing partial unique `loans_user_id_pending_unique` (one PENDING_COLLATERAL per user) is unaffected.

### 4.2 State machine

CLAUDE.md §6 transitions table loses these rows:

| ~~From~~ | ~~To~~ | ~~Triggered by~~ | ~~reason_code~~ |
|---|---|---|---|
| ~~`ACTIVE`~~ | ~~`LIQUIDATED`~~ | ~~Loan-maturity worker — past `due_at + LOAN_GRACE_PERIOD_DAYS`~~ | ~~`MATURITY_GRACE_EXPIRED`~~ |

`PENDING_COLLATERAL → EXPIRED` (via `INVOICE_EXPIRED`, the 30-min collateral-payment window) **stays** — that's the invoice expiry, not loan duration.

`LoanReasonCodes` enum loses: `MATURITY_GRACE_STARTED`, `MATURITY_GRACE_EXPIRED`. All other codes unchanged.

Margin-call notifications are **not** state changes. Loan stays ACTIVE. No log row.

### 4.3 Worker changes

| Worker | Change |
|---|---|
| `liquidation-monitor` | **Extended.** Per-loan loop: compute outstanding + collateral_ngn (existing), then evaluate coverage tiers. `< 1.10` → liquidate (existing). `< 1.15 && !redis_has(margin_call:loan_id)` → send MARGIN_CALL email, set Redis key. `< 1.20 && !redis_has(warn:loan_id)` → send WARN email, set Redis key. `≥ 1.20` → clear both Redis keys. |
| `loan-maturity-expiry` | **DELETED.** No more due dates. |
| `loan-reminder` | **DELETED.** No more due-date-cadence reminders. LTV-tier notifications subsume the customer-warning role. |
| `payment-request-expiry` | Unchanged (still expires 30-min collateral invoices). |
| `collateral-release` | Unchanged. |
| `outflow-reconciler` | Unchanged. |
| `disbursement-on-hold-digest` | Unchanged. |
| `price-feed` | Unchanged. |

Coverage-tier evaluation lives inside `liquidation-monitor` because it already computes the exact ratio per loan, and recovery-aware dedupe is a single consistent view of (outstanding, collateral_ngn) across all three thresholds.

### 4.4 Service changes

`LoansService.checkout`:
- Drop `term_days` from `CheckoutLoanDto`.
- Drop `due_at` computation.
- Persist Loan with `due_at = null`-equivalent (or, post-migration, no column at all).

`CalculatorService.computeQuote`:
- Drop `term_days` parameter.
- Single output shape: daily rates + origination + collateral math. No projections.

`AccrualService.compute`: **unchanged**. Already term-agnostic.

`LoansService.creditInflow`: **unchanged.** Repayment waterfall, REPAID transition, post-commit collateral-release call all behave the same.

`LiquidationMonitorService.evaluateLoan(loan)` (new internal method, called by the existing per-loan loop):
1. Compute `outstanding`, `collateral_ngn`, `coverage = collateral_ngn / outstanding`.
2. If `coverage < 1.10`: `triggerLiquidation(loan, reason='LIQUIDATION_TRIGGERED')`. Done.
3. If `coverage < 1.15`: ensure MARGIN_CALL notice fired (Redis SETNX); else clear MARGIN_CALL key.
4. If `coverage < 1.20`: ensure WARN notice fired (Redis SETNX); else clear WARN key.
5. If `coverage ≥ 1.20`: clear both keys.

`OpsAlertsService` already exposes the email plumbing for ops-paging. Add a parallel `CustomerNotificationsService` (or extend `OpsAlertsService` with customer-facing methods — judgment call) for `sendCoverageWarn(loan)` and `sendMarginCall(loan)`. Both use the same `EmailProvider` interface as auth OTPs.

### 4.5 Constants (`src/common/constants/index.ts`)

**Add:**
```typescript
COVERAGE_WARN_TIER          = 1.20  // first customer notice — informational
COVERAGE_MARGIN_CALL_TIER   = 1.15  // urgent margin call — top up or repay immediately
```

**Keep unchanged:**
```typescript
LIQUIDATION_THRESHOLD       = 1.10  // forced close — applies always, no grace
ALERT_THRESHOLD             = 1.20  // ops-internal alert — same boundary as COVERAGE_WARN_TIER, kept separate for audience clarity
```

**Remove:**
```typescript
MIN_LOAN_DURATION_DAYS      = 1
MAX_LOAN_DURATION_DAYS      = 90
LOAN_GRACE_PERIOD_DAYS      = 7
```

`MIN_PARTIAL_REPAYMENT_NGN`, `COLLATERAL_INVOICE_EXPIRY_SEC`, `COLLATERAL_TOPUP_EXPIRY_SEC`, `ALERT_COOLDOWN_SEC`, etc. unchanged.

### 4.6 Redis keys

**New:**
- `coverage_warn:{loan_id}` — set when coverage crosses below 1.20; cleared when above 1.20.
- `coverage_margin_call:{loan_id}` — set when coverage crosses below 1.15; cleared when above 1.15.

No TTL — these are state, not cache. Cleared explicitly in `liquidation-monitor` recovery branch and on terminal loan transitions (REPAID / LIQUIDATED) by piggybacking on existing post-transition cleanup.

### 4.7 API contract changes

`POST /v1/loans/checkout`:
```typescript
class CheckoutLoanDto {
  @IsInt() @Min(MIN_LOAN_NGN) principal_ngn!: number;
  @IsUUID() disbursement_account_id!: string;
  // term_days removed
}
```

`POST /v1/calculator/quote`:
```typescript
class QuoteDto {
  @IsInt() @Min(MIN_LOAN_NGN) principal_ngn!: number;
  // term_days removed
}
```

`GET /v1/loans/:id` response:
- Remove: `due_at`, `term_days`, `days_remaining`, `projected_*` fields.
- Add: `coverage_ratio: string`, `days_active: number`, `margin_call_active: boolean`.

### 4.8 Tests

Unit:
- `CalculatorService.computeQuote` — single output shape, no `term_days`.
- `LoansService.checkout` — DTO without `term_days` succeeds; disbursement persists with no due_at column.
- `LiquidationMonitorService.evaluateLoan`:
  - Coverage 1.30 → no notice, all keys cleared.
  - Coverage 1.18 → WARN fires once; second tick at 1.18 sets nothing new.
  - Coverage 1.13 → MARGIN_CALL fires (and WARN already set). Second tick at 1.13 sets nothing.
  - Coverage 1.05 → liquidation triggered, no MARGIN_CALL/WARN re-fire.
  - Recovery: 1.13 → 1.18 → MARGIN_CALL key cleared; WARN remains. 1.18 → 1.25 → both cleared.
  - Re-firing after recovery: 1.25 → 1.13 → MARGIN_CALL fires again (recovery-aware).

Integration:
- Loan with no `term_days` checkouts cleanly, disburses, accrues, repays.
- LTV-triggered liquidation works on a loan that has never had a due date.
- Margin call email actually sends on the threshold crossing (verified via fake email transport).

E2E:
- Full happy path: checkout → collateral webhook → ACTIVE → repay → REPAID → release-address → collateral sent. No term_days anywhere in the request/response cycle.

### 4.9 Migration plan

Order of operations:

1. **Code prep (no DB change yet):**
   - Add new constants (`COVERAGE_WARN_TIER`, `COVERAGE_MARGIN_CALL_TIER`, `MARGIN_CALL_TARGET_HOURS`).
   - Extend `LiquidationMonitorService` with the three-tier evaluation. Initially gated behind a feature flag so it runs alongside the existing maturity workers without firing duplicate emails.
   - Add `CustomerNotificationsService.sendCoverageWarn` + `sendMarginCall`.
   - Update `CheckoutLoanDto` to make `term_days` optional (transitional).
   - Update `CalculatorService` to ignore `term_days` if passed (transitional).
2. **Drain existing loans:** wait for every loan with a non-null `due_at` to reach a terminal state (REPAID / LIQUIDATED / EXPIRED). Exact drain end date is `SELECT MAX(due_at) + INTERVAL '7 days' FROM loans WHERE status IN ('PENDING_COLLATERAL', 'ACTIVE')` at cutover time. During the drain, `loan-maturity-expiry` and `loan-reminder` workers continue to run on those legacy loans only.
3. **Cut over:**
   - Stop and remove `loan-maturity-expiry` + `loan-reminder` workers.
   - Remove `MIN_LOAN_DURATION_DAYS`, `MAX_LOAN_DURATION_DAYS`, `LOAN_GRACE_PERIOD_DAYS` constants.
   - Remove `MATURITY_GRACE_STARTED` and `MATURITY_GRACE_EXPIRED` from `LoanReasonCodes`.
   - Drop `term_days` from `CheckoutLoanDto` entirely.
4. **Schema migration:** drop `loans.term_days` and `loans.due_at` columns. Trivial DDL once no code reads them.
5. **Web client (`bitmonie-web`):** remove the term picker, simplify the calculator, update loan-detail screens. `docs/web.md` + mirrored copy at `~/source/apps/bitmonie-web/docs/web.md` updated alongside.

If product wants to launch faster than the ~97-day drain, the alternative is to backfill `due_at = null` and immediately stop running the two deleted workers, treating in-flight legacy loans as if they had been Anytime all along. That's a one-time write to existing rows + a customer email explaining the change. Acceptable but should be a deliberate decision.

---

## 5. Documents to update on lock

- `CLAUDE.md` — §2 (scope: no duration), §5.4 (drop maturity from state-machine prose), §5.4a (drop maturity-grace references), §6 (transitions table — remove maturity rows; LoanReasonCodes — drop maturity codes), §9 (constants — add coverage tiers, remove duration constants), §10 (drop the calculator-projection language; replace with daily-rates-only)
- `docs/prd.md` — single-product checkout, no term picker, calculator UX, margin-call flow
- `docs/tdd.md` — schema column drops, worker deletions, `LiquidationMonitorService` extension, `CustomerNotificationsService`, Redis key conventions
- `docs/workers.md` — delete `loan-maturity-expiry` + `loan-reminder` sections; expand `liquidation-monitor` to cover the three-tier evaluation
- `docs/web.md` + mirrored copy at `~/source/apps/bitmonie-web/docs/web.md` — DTO + response shape changes, calculator simplification
- `docs/errors.md` — no new error codes
