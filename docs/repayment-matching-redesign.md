# Loan v1.1 — Pricing Overhaul, Partial Repayments, Add-Collateral, Permanent VAs

Status: **design locked, not yet implemented**. Session 2026-04-22.
Supersedes the earlier "Repayment Matching Redesign" sketch in this same file.

> This design materially changes the loan product. It overrides CLAUDE.md §2 (scope), §9 (constants), §10 (fee calc), and parts of §5.4 (liquidation math). Those files are updated alongside implementation, not in this doc.

---

## 0. Why this exists

Three forces converged into one design:

1. **PalmPay dedicated VAs are permanent per BVN**, not per-loan. The earlier wiring (provision a VA on loan ACTIVATE, match by `accountReference = loan_id`) doesn't fit. → One VA per user, reused across every loan.
2. **PalmPay doesn't forward the bank-transfer narration** on deposit notifications (confirmed by PalmPay). → Narration-based loan disambiguation is impossible. Amount + explicit customer claim + ops fallback is the only path.
3. **Product direction shift**: customers in BTC drawdowns previously had no defensive tools — liquidation was the only outcome. → Partial repayments (reducing balance) + add-collateral flow.

(3) forces a fee-model redesign, because fixed pre-computed totals no longer make sense once the outstanding balance moves.

Explicitly **not** in this design: naira wallet, yield product, multi-channel deposit inflows, non-SAT collateral, loan extensions beyond the 7-day grace.

---

## 1. Locked decisions

| # | Decision |
|---|---|
| 1 | **Origination fee**: `ceil(principal_ngn / 100_000) × 500`. One-time, charged at disbursement. |
| 2 | **Interest**: 0.3% daily on **outstanding principal**. Simple (non-compounding), accrues daily, never charged upfront. |
| 3 | **Custody fee**: `ceil(initial_collateral_usd / 100) × 100` NGN per day. **Fixed at origination** — does not float with BTC price. Sub-$100 collateral still ceils to 1 unit = N100/day (no floor needed; the ceil rule handles it). |
| 4 | **Max loan duration**: 90 days (was 30). Min unchanged at 1. |
| 5 | **Liquidation threshold**: `collateral_ngn < 1.10 × (outstanding_principal + accrued_interest + accrued_custody)`. Recomputed every monitor tick. |
| 6 | **Maturity**: 7-day grace period. Reminders at T−7d, T−1d, T (maturity day), then daily through grace. Hard liquidation after grace. |
| 7 | **Partial repayments**: allowed. Minimum **N10,000** per inflow. Below floor → inflow stored uncredited, ops handles. UI enforces minimum. |
| 8 | **Overpayment**: any inflow ≥ current outstanding repays the loan in full; excess is queued for ops refund. |
| 9 | **Add-collateral**: fresh Lightning invoice per top-up request, 30-min expiry. At most one open top-up per loan at a time. |
| 10 | **Matching**: permanent VA per user, amount-based match against that user's ACTIVE loans. Ambiguity → customer uses claim-inflow endpoint → ops queue as last resort. |
| 11 | **Collateral release**: all-or-nothing on REPAID. Partial repayments never release collateral. |

---

## 2. Schema changes

### 2.1 `Loan` model — columns to drop

These are meaningful only under a fixed-total fee model and become misleading under accrual:

- `daily_fee_ngn` — fees aren't paid daily upfront anymore; interest + custody accrue.
- `total_fees_ngn` — no fixed total exists; it grows with time and shrinks with partial repayments.
- `total_amount_ngn` — same reason.
- `liquidation_rate_ngn`, `alert_rate_ngn` — derived from principal alone; with accrual, the rate thresholds move daily. The liquidation monitor recomputes every tick from current outstanding + current collateral USD value.

### 2.2 `Loan` model — columns to add

```prisma
model Loan {
  // ...existing (unchanged): id, user_id, disbursement_account_id, collateral_*, ltv_percent,
  //                          principal_ngn, origination_fee_ngn, duration_days, due_at,
  //                          status, sat_ngn_rate_at_creation, repayment_*, disbursement_id,
  //                          collateral_release_*, liquidated_*, created_at, updated_at

  // NEW — accrual inputs
  daily_interest_rate_bps Int     @default(30)                    // 30 bps = 0.3%
  daily_custody_fee_ngn   Decimal @db.Decimal(20, 2)              // fixed at origination
  initial_collateral_usd  Decimal @db.Decimal(20, 2)              // for audit / UI display

  // NEW — partial-repayment accounting
  repayments              LoanRepayment[]

  // NEW — add-collateral support
  collateral_topups       CollateralTopUp[]

  // Keep `collateral_received_at` — still used by liquidation monitor as "when to start counting days".
}
```

Status enum unchanged. No new statuses.

### 2.3 New `LoanRepayment` model

Append-only ledger of credited repayments. Never updated once inserted. The source of truth for "how much principal has been paid down."

```prisma
model LoanRepayment {
  id                   String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  loan_id              String   @db.Uuid
  inflow_id            String   @unique @db.Uuid          // one repayment per inflow
  amount_ngn           Decimal  @db.Decimal(20, 2)
  applied_to_principal Decimal  @db.Decimal(20, 2)        // may be < amount_ngn on overpay (final)
  applied_to_interest  Decimal  @db.Decimal(20, 2)        // accrued-interest portion settled
  applied_to_custody   Decimal  @db.Decimal(20, 2)        // accrued-custody portion settled
  overpay_ngn          Decimal  @default(0) @db.Decimal(20, 2)  // only non-zero on final/closing payment
  match_method         String   @db.VarChar(20)           // 'AUTO_AMOUNT' | 'CUSTOMER_CLAIM' | 'OPS_MANUAL'
  created_at           DateTime @default(now()) @db.Timestamptz

  loan   Loan   @relation(fields: [loan_id], references: [id])
  inflow Inflow @relation(fields: [inflow_id], references: [id])

  @@index([loan_id, created_at])
  @@map("loan_repayments")
}
```

**Repayment waterfall (priority order):**
1. Accrued custody (oldest unsettled first)
2. Accrued interest (oldest unsettled first)
3. Outstanding principal
4. Excess → `overpay_ngn` (only on the payment that closes the loan)

Rationale: paying fees-first keeps the outstanding-principal definition clean (principal − sum(applied_to_principal)), so the interest calc next day is based on correctly-reduced principal.

### 2.4 New `CollateralTopUp` model

Tracks an add-collateral session end-to-end. One open row per loan at a time (enforced by a partial unique index).

```prisma
enum TopUpStatus {
  PENDING_COLLATERAL
  RECEIVED
  EXPIRED
  CANCELLED

  @@map("topup_status")
}

model CollateralTopUp {
  id                       String       @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  loan_id                  String       @db.Uuid

  // Provider invoice data — mirrors the loan's initial collateral fields
  collateral_provider      String       @db.VarChar(50)   // 'blink'
  collateral_provider_ref  String       @unique @db.VarChar(255)
  payment_request          String       @db.VarChar(2000)   // BOLT11
  receiving_address        String       @db.VarChar(512)
  expected_amount_sat      BigInt
  expires_at               DateTime     @db.Timestamptz

  received_amount_sat      BigInt?      // set on inflow match
  received_at              DateTime?    @db.Timestamptz

  status                   TopUpStatus  @default(PENDING_COLLATERAL)
  created_at               DateTime     @default(now()) @db.Timestamptz
  updated_at               DateTime     @updatedAt @db.Timestamptz

  loan Loan @relation(fields: [loan_id], references: [id])

  @@index([loan_id, status])
  @@map("collateral_topups")
}

// Partial unique: at most one PENDING_COLLATERAL top-up per loan at a time.
// (Prisma raw SQL in the migration — no native partial-unique in the schema language.)
```

### 2.5 Replace `LoanRepaymentAccount` with `UserRepaymentAccount`

From the original sketch — unchanged. Unique on `user_id`, not `loan_id`.

```prisma
model UserRepaymentAccount {
  id                   String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  user_id              String   @unique @db.Uuid
  virtual_account_no   String   @unique @db.VarChar(50)
  virtual_account_name String   @db.VarChar(255)
  provider             String   @db.VarChar(50)          // 'palmpay'
  provider_reference   String?  @db.VarChar(255)
  created_at           DateTime @default(now()) @db.Timestamptz

  user User @relation(fields: [user_id], references: [id], onDelete: Restrict)

  @@map("user_repayment_accounts")
}
```

### 2.6 Migration strategy

- Dev DB: `DROP TABLE loan_repayment_accounts CASCADE` (empty, safe).
- Rewrite the existing `20260421010000_loan_repayment_accounts` migration in place to produce the final v1.1 schema: `user_repayment_accounts`, `loan_repayments`, `collateral_topups`, plus the `loans` column changes (drop 5, add 3).
- Rename the migration folder to reflect scope: `20260421010000_loan_v1_1_schema`.

Prod is not yet deployed, so no forward-only migration needed.

---

## 3. Accrual engine

Pure function. No DB writes, no timestamps from the caller — reads the loan's immutable inputs and `now()`. Unit-testable with injected clock.

```ts
// src/modules/loans/accrual.service.ts

export interface Outstanding {
  principal_ngn: Decimal;              // current outstanding principal
  accrued_interest_ngn: Decimal;       // unpaid interest accrued to date
  accrued_custody_ngn: Decimal;        // unpaid custody accrued to date
  total_outstanding_ngn: Decimal;      // sum of the above
  days_elapsed: number;                // integer days from collateral_received_at to now
  as_of: Date;
}

@Injectable()
export class AccrualService {
  /**
   * Compute outstanding for a loan at a given instant.
   * Called by: liquidation monitor, GET /v1/loans/:id, repayment waterfall.
   * Must be deterministic — same inputs → same output.
   */
  compute(params: {
    loan: Pick<Loan,
      'principal_ngn' | 'daily_interest_rate_bps' | 'daily_custody_fee_ngn' | 'collateral_received_at'>;
    repayments: Pick<LoanRepayment, 'applied_to_principal' | 'applied_to_interest' | 'applied_to_custody' | 'created_at'>[];
    as_of: Date;
  }): Outstanding;
}
```

**Daily boundary:** days_elapsed counts calendar UTC days from `collateral_received_at` to `as_of`. Partial days count as a full day (ceil) — a repayment 2 hours after origination still incurs 1 day of interest + custody. This is the product call; it's the simplest model and prevents sub-second repayment gaming.

**Accrued interest:**
```
daily_interest_ngn_at_day(d) = current_principal_at_end_of_day(d - 1) × rate_bps / 10000
accrued_interest              = sum over days of daily_interest at-that-day
                              − sum(applied_to_interest) across repayments
```
Because rate is on principal only (non-compounding), and principal only moves at repayment timestamps, this is a piecewise-linear function of time — cheap to compute with a loop over repayments + segment lengths.

**Accrued custody:**
```
accrued_custody = daily_custody_fee_ngn × days_elapsed
                − sum(applied_to_custody) across repayments
```
Custody is flat per day (fixed at origination), so it doesn't depend on principal. Simplest term.

**Outstanding principal:**
```
outstanding_principal = principal_ngn − sum(applied_to_principal) across repayments
```

### Worked example

Loan: N500,000 principal, collateral $625 USD-equivalent at origination, 60-day term.

- origination_fee = `ceil(500_000 / 100_000) × 500` = **N2,500** (charged upfront, not accrued)
- daily_custody_fee = `ceil(625 / 100) × 100` = **N700/day**
- daily_interest = varies with outstanding principal

Day 30 (no repayments yet):
- accrued_interest = 0.003 × 500,000 × 30 = N45,000
- accrued_custody = 700 × 30 = N21,000
- outstanding_total = 500,000 + 45,000 + 21,000 = **N566,000**

Day 30 customer pays N100,000 (partial, above the N10k floor):
- Waterfall: 21,000 (custody) + 45,000 (interest) + 34,000 (principal) = 100,000
- After: outstanding_principal = 500,000 − 34,000 = **N466,000**
- Days 31–60 interest accrues on N466k: 0.003 × 466,000 × 30 = N41,940
- Days 31–60 custody: 700 × 30 = N21,000
- Outstanding at day 60 (no further payment): 466,000 + 41,940 + 21,000 = **N528,940**

Day 60 customer pays N528,940: waterfall clears all three, `overpay_ngn = 0`, loan → REPAID.

---

## 4. CalculatorService rewrite

Calculator now returns **projections**, not fixed totals. The customer sees "if you repay exactly on day X, you will have paid Y." The UI makes clear these are projections.

**BTC/USD rate source: Blink.** For `initial_collateral_usd` at origination, Blink is the rate source, not Quidax. Blink gives a direct BTC/USD quote (cleaner than the Quidax cross-rate `sat_ngn_rate / usdt_ngn_rate`). Formula:
```
initial_collateral_usd = (collateral_amount_sat / 100_000_000) × blink_btc_usd_rate
```
The Quidax price feed remains authoritative for everything else (SAT/NGN for collateral sizing, USDT/NGN for loan-side math). Blink is used at this one boundary only.

**Architectural note.** Blink currently implements `CollateralProvider` only. Exposing a BTC/USD price method means either (a) extending that interface with an optional `getBtcUsdRate()`, or (b) introducing a narrow new interface `PriceQuoteProvider` that Blink can also implement. Decide at build time — I'd lean toward (b) since "price feed" and "collateral provider" are distinct roles and `§5.2` says role-not-provider. Flag but not a blocker.

```ts
export interface CalculatorResult {
  // Known-at-origination
  principal_ngn:             Decimal;
  origination_fee_ngn:       Decimal;       // ceil(principal / 100k) × 500
  daily_custody_fee_ngn:     Decimal;       // ceil(collateral_usd / 100) × 100
  daily_interest_rate_bps:   number;        // 30

  collateral_amount_sat:     bigint;
  initial_collateral_usd:    Decimal;
  ltv_percent:               Decimal;
  sat_ngn_rate_at_creation:  Decimal;

  // Projections (for chosen duration)
  duration_days:             number;
  projected_interest_ngn:    Decimal;       // 0.003 × principal × duration
  projected_custody_ngn:     Decimal;       // daily_custody × duration
  projected_total_ngn:       Decimal;       // principal + origination + projected_interest + projected_custody

  // Initial thresholds (for UI only — not stored; liquidation monitor recomputes live)
  initial_liquidation_rate_ngn: Decimal;
  initial_alert_rate_ngn:       Decimal;
}
```

Validation unchanged: min/max principal, min/max duration (1–90). Min loan stays N50,000 per CLAUDE.md §9.

---

## 5. Partial-repayment flow

### 5.1 Webhook path (PalmPay collection notification)

Endpoint: **POST /v1/webhooks/palmpay/collection/va** — one path per PalmPay
webhook role so the merchant dashboard targets each controller individually
and a misrouted payload becomes a 4xx instead of a silent drop.

Sibling routes:

- `POST /v1/webhooks/palmpay/payout`               — outbound transfer status
- `POST /v1/webhooks/palmpay/collection/universal` — reserved for PalmPay
  Checkout (multi-method payin) — not yet implemented

```
 1. Verify signature (raw body) → 401 on mismatch.
 2. Parse payload via PalmpayCollectionNotificationSchema.
 3. Reject if orderStatus != PALMPAY_COLLECTION_STATUS_SUCCESS (=1).
    NOTE: collection scheme uses 1=success / 2=failed. This DIVERGES from
    payouts (where 2=success). Reusing the payout enum drops every repayment.
 4. Resolve user: virtual_account_no → UserRepaymentAccount.user_id.
    No match → Inflow(is_matched=false, reason='no_user_for_va'), alert ops.
 5. amount_ngn = orderAmount / 100.
 6. Floor check: amount_ngn < N10,000
      → Inflow(is_matched=false, reason='below_floor'), alert ops. Return ACK.
 7. Find ACTIVE loans for this user.
      Zero → Inflow(is_matched=false, reason='no_active_loans'), alert ops.
 8. Auto-match decision:
      - Exactly ONE ACTIVE loan → continue.
      - Multiple ACTIVE loans → **smart-match step**:
          For each ACTIVE loan, compute current total outstanding via
          AccrualService.compute(...). Pick loans whose outstanding equals
          the inflow amount within ±₦0.50 (INFLOW_OUTSTANDING_MATCH_TOLERANCE_NGN
          — absorbs sub-naira accrual fractions).
          - Exactly one such loan → continue with that loan.
          - Multiple such loans → tiebreaker: oldest by Loan.created_at.
          - No matches → Inflow(is_matched=false, reason='multiple_active_loans'),
            customer self-serves via the inflows surface (§7).
 9. Defence-in-depth: re-query PalmPay (PalmpayProvider.getCollectionOrderStatus)
    using the webhook's orderNo. Only proceed when:
      a. status == 'successful', AND
      b. queried amount_kobo == webhook orderAmount (no tolerance), AND
      c. queried virtualAccountNo == webhook virtualAccountNo.
    Outcomes:
      - Throw / 'unknown' → defer; PalmPay will redeliver.
      - 'failed'           → Inflow(is_matched=false, reason='requery_mismatch'),
                             alert ops, no credit.
      - Field mismatch     → Inflow(is_matched=false, reason='requery_mismatch'),
                             alert ops, no credit.
10. Auto-credit (match_method='AUTO_AMOUNT'). See §5.2.
11. Respond with PalmPay ACK.
```

No narration parsing anywhere. No amount-equals-total matching. "Does the customer have one active loan, AND does PalmPay's own order record confirm the funds settled with this amount on this VA?" is the auto-match condition.

### 5.2 Credit transaction (atomic)

All in one Prisma transaction:

```ts
async creditInflowToLoan(params: {
  inflow_id: string;
  loan_id: string;
  amount_ngn: Decimal;
  match_method: 'AUTO_AMOUNT' | 'CUSTOMER_CLAIM' | 'OPS_MANUAL';
}): Promise<void> {
  return this.prisma.$transaction(async (tx) => {
    // 1. Lock loan row for update
    const loan = await tx.$queryRaw`SELECT * FROM loans WHERE id = ${loan_id} FOR UPDATE`;

    // 2. Reject if loan is terminal (idempotent — duplicate webhook after REPAID just ACKs)
    if (['REPAID', 'LIQUIDATED', 'EXPIRED', 'CANCELLED'].includes(loan.status)) {
      throw new LoanNotActiveException(...);
    }

    // 3. Compute outstanding as-of now (accrual engine)
    const outstanding = accrual.compute({ loan, repayments: existing, as_of: new Date() });

    // 4. Apply waterfall
    const { applied_to_custody, applied_to_interest, applied_to_principal, overpay_ngn }
      = waterfall(amount_ngn, outstanding);

    // 5. Insert LoanRepayment row
    await tx.loanRepayment.create({ data: {...} });

    // 6. Mark Inflow matched
    await tx.inflow.update({ where: { id: inflow_id }, data: { is_matched: true, source_id: loan_id, source_type: 'LOAN_REPAYMENT' } });

    // 7. If outstanding is now 0: transition ACTIVE → REPAID, write loan_status_logs row.
    //    Else: remain ACTIVE, write loan_status_logs row with reason_code REPAYMENT_PARTIAL_NGN.
    if (new_outstanding.total_outstanding_ngn.isZero()) {
      await tx.loan.update({ where: { id: loan_id }, data: { status: 'REPAID', repaid_at: new Date() } });
      await writeStatusLog(tx, { to_status: 'REPAID', reason_code: 'REPAYMENT_COMPLETED' });
      // Collateral release is a separate downstream concern — enqueue it.
    } else {
      await writeStatusLog(tx, { to_status: 'ACTIVE', reason_code: 'REPAYMENT_PARTIAL_NGN' });
    }
  });
}
```

Idempotency is preserved at two levels: (a) `LoanRepayment.inflow_id @unique` blocks double-credit per Inflow, (b) Inflow.`provider_reference @unique` blocks double-ingestion of the same PalmPay event.

### 5.3 Collateral release (unchanged from v1)

Remains all-or-nothing on REPAID. Partial repayments don't touch collateral. This is a deliberate safety property — releasing partial collateral would create an attack surface (repay N1 of a N1M loan, demand N0.99 of collateral back).

---

## 6. Add-collateral flow

### 6.1 Endpoint

```
POST /v1/loans/:id/add-collateral
Auth: SessionGuard
Idempotency-Key required.

Request body: (empty — amount is implied by the customer's wallet/UX)

Response 201:
{
  "topup_id":         "uuid",
  "payment_request":  "lnbc...",
  "receiving_address": "bc1...",
  "expected_amount_sat": null,         // variable — customer sends what they want
  "expires_at":       "ISO-8601",
  "loan_id":          "uuid"
}
```

Behavior:
- Reject with 409 if the loan isn't ACTIVE.
- Reject with 409 if a PENDING_COLLATERAL `CollateralTopUp` already exists for this loan (enforced by partial unique index).
- Create a variable-amount Lightning invoice (Blink supports this via "receive any amount"). 30-min expiry.
- Insert a `CollateralTopUp` row.
- Cache `payment_request:pending:{receiving_address}` in Redis (same pattern as loan collateral) so the collateral webhook handler finds it on inflow.

### 6.2 Collateral webhook path (Blink)

Today's handler resolves `PaymentRequest` from `receiving_address`. Extend it to also check `collateral_topups.receiving_address`. Separate code path per `source_type` is cleaner:

```ts
// On collateral inflow:
// 1. Check if receiving_address belongs to a PaymentRequest (loan initial collateral) — existing path.
// 2. Else, check collateral_topups by receiving_address.
// 3. If neither, write Inflow with is_matched=false, alert ops.
```

On top-up match (atomic transaction):

```ts
await prisma.$transaction([
  // 1. Update loan: collateral_amount_sat += received_sat
  prisma.loan.update({
    where: { id: loan_id },
    data: { collateral_amount_sat: { increment: received_sat } },
  }),
  // 2. Mark top-up RECEIVED
  prisma.collateralTopUp.update({
    where: { id: topup_id },
    data: { status: 'RECEIVED', received_amount_sat: received_sat, received_at: new Date() },
  }),
  // 3. Inflow matched
  prisma.inflow.update({
    where: { id: inflow_id },
    data: { is_matched: true, source_type: 'COLLATERAL_TOPUP', source_id: topup_id },
  }),
  // 4. loan_status_logs — ACTIVE → ACTIVE, reason_code COLLATERAL_TOPPED_UP, metadata { received_sat }
]);
```

Note: **no status change** — loan stays ACTIVE. The status log captures the event. Liquidation monitor will pick up the new collateral on its next tick automatically since the threshold is recomputed live.

### 6.3 Expiry

Extend the existing payment-request expiry worker to also expire pending `CollateralTopUp` rows (set status EXPIRED). Alternatively, fold it into a generic expiry worker — implementation choice at build time.

---

## 7. Liquidation monitor changes

Current behavior: computes liquidation against `principal_ngn × 1.10`. Replace with live accrual-aware check:

```ts
// workers/liquidation-monitor.worker.ts — per loan tick

const outstanding = await accrual.compute({ loan, repayments, as_of: now });
const collateral_ngn = loan.collateral_amount_sat × current_sat_ngn_rate;

const liquidation_ngn = outstanding.total_outstanding_ngn.mul(LIQUIDATION_THRESHOLD);  // 1.10
const alert_ngn       = outstanding.total_outstanding_ngn.mul(ALERT_THRESHOLD);        // 1.20

if (collateral_ngn.lt(liquidation_ngn)) → liquidate
else if (collateral_ngn.lt(alert_ngn))  → alert (honor 24h cooldown)
```

All other monitor invariants preserved: `FOR UPDATE SKIP LOCKED`, heartbeat, 24h alert cooldown per CLAUDE.md §12.

---

## 8. Maturity + grace period + reminders

### 8.1 Timeline per loan

```
due_at = collateral_received_at + duration_days

T − 7d    send reminder: "your loan matures in 7 days"
T − 1d    send reminder: "your loan matures tomorrow"
T         send reminder: "your loan is now due — 7-day grace period begins"
T + 1d    daily reminder through grace
T + 2d    ...
T + 7d    FINAL reminder: "loan will be liquidated tomorrow if not repaid"
T + 8d    loan-maturity worker: if still ACTIVE, force-liquidate via existing LIQUIDATION path
```

Reminders in v1 are email only (Postmark or whatever the existing transactional mailer is). No SMS.

### 8.2 Loan-maturity worker (renamed from loan-expiry)

Existing `workers/loan-expiry.worker.ts` handles PENDING_COLLATERAL → EXPIRED. Extend (don't replace) for ACTIVE loans past grace:

- Tick daily.
- For each loan in ACTIVE where `due_at + 7d < now`: call the liquidation path. The reason_code on the status log is `MATURITY_GRACE_EXPIRED` (new) rather than `LIQUIDATION_TRIGGERED`.
- Accrual continues through the grace period — customer who repays on T+3d pays 3 extra days of interest + custody. This is intentional.

### 8.3 Reminder worker

New worker `workers/loan-reminder.worker.ts`. Ticks hourly. For each ACTIVE loan:
- Compute which reminder slot the loan is in (T−7d, T−1d, T, T+N).
- Check Redis `reminder_sent:{loan_id}:{slot}` to avoid duplicates.
- Send email via the transactional mailer. Set the Redis key with a long TTL.

**Email infrastructure plan for v1.1:**
- Extend the existing `EmailProvider` interface ([src/modules/auth/email.provider.interface.ts](src/modules/auth/email.provider.interface.ts)) with a generic `sendTransactional({ to, subject, text_body, html_body })` method. Implement in all three providers (Mailgun active, Resend + Postmark as alternates).
- Template content is **hardcoded** (matches the current `buildOtpEmail` style in each provider). One helper per reminder slot in a new `src/modules/loans/reminder-templates.ts` file.
- Same `sendTransactional` method unblocks the ops-alert path referenced throughout this design (unmatched inflows, PalmPay failures, etc.) — one refactor pays for both.
- **v1.2:** migrate to provider-native templating (Mailgun Templates, Postmark TemplateAlias, Resend React Email) once there are 8+ distinct templates. Not now.

---

## 9. Permanent VA — provisioning + matching

(Unchanged from the original sketch; summarized for completeness.)

### 9.1 `UserRepaymentAccountsService.ensureForUser(user_id)`

- Called at the end of tier-1 KYC verification (wrap in try/catch so a PalmPay failure doesn't fail KYC).
- Idempotent: returns existing account if one already exists for the user.
- Uses the customer's decrypted BVN from `kyc_verifications` + legal name.
- `account_reference` on the PalmPay call = `user_id`.

### 9.2 File renames (carryover from original sketch)

- `src/modules/loan-repayment-accounts/` → `src/modules/user-repayment-accounts/`
- `LoanRepaymentAccountsModule/Service` → `UserRepaymentAccountsModule/Service`
- Delete `provisionForLoan`, `getOrCreate({loan_id,...})`; add `ensureForUser(user_id)`.

### 9.3 Wiring

- `KycModule.imports` adds `UserRepaymentAccountsModule`.
- `WebhooksModule.imports` swaps `LoanRepaymentAccountsModule` → `UserRepaymentAccountsModule`.

---

## 10. Inflows surface — "stack of cash rolls"

When a webhook can't auto-credit (multi-active without a smart-match, or no ACTIVE loan at receipt time), the Inflow is persisted unmatched. The customer self-serves via two endpoints — no ops involvement.

### 10.1 List unmatched inflows

```
GET /v1/inflows/unmatched
Auth: SessionGuard

Response 200:
{
  "items": [
    {
      "id":              "inf_uuid",
      "amount_ngn":      "10130.00",
      "received_at":     "2026-04-30T12:00:07Z",
      "payer_name":      "JEREMIAH SUCCEED IKWUJE",
      "payer_bank_name": "OPay",
      "received_via":    "9931107760",
      "status":          "CLAIMABLE"        // or "BELOW_MINIMUM" for sub-N10k inflows
    }
  ]
}
```

Filter: `user_id = current_user AND is_matched = false AND currency = 'NGN' AND source_type IS NULL` and exclude any with `provider_response.bitmonie_unmatched_reason ∈ {requery_mismatch, requery_unconfirmed, credit_failed}` (those are PalmPay-untrusted; ops territory).

### 10.2 Apply a specific inflow to a loan

```
POST /v1/inflows/:inflow_id/apply
Auth: SessionGuard
Idempotency-Key required.

Request body: { "loan_id": "uuid" }

Response 200:
{
  "loan_id":             "uuid",
  "new_status":          "ACTIVE",          // or "REPAID" if the apply closed the loan
  "applied_to_custody":  "350.00",
  "applied_to_interest": "1500.00",
  "applied_to_principal": "8280.00",
  "overpay_ngn":         "0.00",
  "outstanding_ngn":     "491720.00"
}
```

Behavior:
- Inflow must exist, belong to the authenticated user, currency=NGN, `is_matched=false`, and not be in an untrusted state.
- Loan must belong to the authenticated user and be ACTIVE.
- **Floor bypassed** — the floor exists to keep auto-matching from acting on tiny accidental transfers; that doesn't apply when the customer themselves directs the apply. Customer can apply a ₦1,000 inflow to a loan if they choose.
- Credits via `creditInflow(..., match_method='CUSTOMER_CLAIM', skip_floor: true)`.

### 10.3 Legacy claim-inflow (deprecated)

```
POST /v1/loans/:id/claim-inflow
```

Still works for backwards compat. Now reimplemented on top of `applyInflowToLoan` — finds the most recent unmatched inflow for the user (≥₦10k, within 24h) and applies it to the chosen loan. Marked `deprecated: true` in OpenAPI; remove in v1.2.

### 10.4 Ops override (deferred to v1.2)

Admin-only endpoint, not built yet:
```
POST /v1/admin/inflows/:inflow_id/claim-to-loan/:loan_id
```
Same credit logic but bypasses the auth-user check. For unusual triage cases that can't be self-served (e.g., wrong-user attribution).

---

## 11. New reason codes

Add to `LoanReasonCodes` in [src/common/constants/index.ts](src/common/constants/index.ts):

```
REPAYMENT_PARTIAL_NGN     // partial repayment credited, loan stays ACTIVE
REPAYMENT_COMPLETED        // final repayment, ACTIVE → REPAID
COLLATERAL_TOPPED_UP       // add-collateral inflow matched
MATURITY_GRACE_STARTED     // T reached, grace begins (logged once at T)
MATURITY_GRACE_EXPIRED     // T+7d reached, force-liquidate
```

Keep existing codes. `REPAYMENT_RECEIVED_NGN` is removed — replaced by the two above. `REPAYMENT_RECEIVED_SAT` is deferred with the rest of the SAT-repayment flow (not in v1.1).

---

## 12. State machine

**No changes to statuses.** Only semantics shift:

| From | To | Trigger | New reason_code |
|---|---|---|---|
| `ACTIVE` | `ACTIVE` | Partial repayment inflow credited | `REPAYMENT_PARTIAL_NGN` |
| `ACTIVE` | `REPAID` | Final repayment inflow closes outstanding | `REPAYMENT_COMPLETED` |
| `ACTIVE` | `ACTIVE` | Collateral top-up inflow matched | `COLLATERAL_TOPPED_UP` |
| `ACTIVE` | `LIQUIDATED` | Liquidation monitor: collateral < 1.10× outstanding | `LIQUIDATION_TRIGGERED` (unchanged) |
| `ACTIVE` | `LIQUIDATED` | Loan-maturity worker: past T+7d grace | `MATURITY_GRACE_EXPIRED` |

ACTIVE → ACTIVE is permitted **only** when a `loan_status_logs` row is written. Same transaction, same guarantee as any other transition.

---

## 13. Constants changes

Replace in [src/common/constants/index.ts](src/common/constants/index.ts):

```ts
// REMOVE
export const ORIGINATION_FEE_NGN       = new Decimal('500');       // was flat
export const DAILY_FEE_PER_100_NGN     = new Decimal('500');       // whole model obsolete
export const MAX_LOAN_DURATION_DAYS    = 30;                       // now 90

// ADD
export const ORIGINATION_FEE_PER_100K_NGN  = new Decimal('500');   // ceil principal/100k × 500
export const DAILY_INTEREST_RATE_BPS       = 30;                   // 0.3% daily
export const CUSTODY_FEE_PER_100_USD_NGN   = new Decimal('100');   // ceil collateral_usd/100 × 100 per day
export const MIN_PARTIAL_REPAYMENT_NGN     = new Decimal('10000');
export const LOAN_GRACE_PERIOD_DAYS        = 7;
export const MAX_LOAN_DURATION_DAYS        = 90;                   // replaces above
export const COLLATERAL_TOPUP_EXPIRY_SEC   = 1800;                 // 30 min, matches COLLATERAL_INVOICE_EXPIRY_SEC
```

Keep: `LOAN_LTV_PERCENT`, `LIQUIDATION_THRESHOLD`, `ALERT_THRESHOLD`, `MIN_LOAN_NGN`, `MAX_SELFSERVE_LOAN_NGN`, `MIN_LOAN_DURATION_DAYS`.

---

## 14. Files to touch (implementation checklist)

| File | Change |
|---|---|
| [prisma/schema.prisma](prisma/schema.prisma) | `Loan`: drop 5 cols, add 3 cols, add `repayments`/`collateral_topups` relations. New models: `UserRepaymentAccount`, `LoanRepayment`, `CollateralTopUp`, enum `TopUpStatus`. Drop `LoanRepaymentAccount`. |
| [prisma/migrations/20260421010000_loan_repayment_accounts/migration.sql](prisma/migrations/20260421010000_loan_repayment_accounts/migration.sql) | Rewrite in place; rename folder to `20260421010000_loan_v1_1_schema`. Include partial unique index on `collateral_topups (loan_id) WHERE status = 'PENDING_COLLATERAL'`. |
| [src/common/constants/index.ts](src/common/constants/index.ts) | Constants per §13. Add new reason codes per §11. |
| [src/modules/loans/calculator.service.ts](src/modules/loans/calculator.service.ts) | Rewrite per §4 — projections not fixed totals. |
| [src/modules/loans/accrual.service.ts](src/modules/loans/accrual.service.ts) | **New file**. Pure function, clock injection for tests. |
| [src/modules/loans/loans.service.ts](src/modules/loans/loans.service.ts) | `checkoutLoan`: stores `daily_interest_rate_bps`, `daily_custody_fee_ngn`, `initial_collateral_usd`. `processRepayment` rewritten to waterfall + partial support. `GET /v1/loans/:id` shape now returns live outstanding (from accrual). |
| [src/modules/loans/loans.controller.ts](src/modules/loans/loans.controller.ts) | Add `POST /v1/loans/:id/add-collateral`, `POST /v1/loans/:id/claim-inflow`. Updated GET response shape. |
| [src/modules/loans/dto/*.ts](src/modules/loans/dto/) | New DTOs: `AddCollateralResponseDto`, `ClaimInflowResponseDto`, updated `LoanResponseDto`. |
| `src/modules/user-repayment-accounts/` | Rename from `loan-repayment-accounts/`; `ensureForUser(user_id)`. |
| [src/modules/kyc/kyc.service.ts](src/modules/kyc/kyc.service.ts) | Call `ensureForUser` at end of tier-1 verification (try/catch). |
| [src/modules/kyc/kyc.module.ts](src/modules/kyc/kyc.module.ts) | Import `UserRepaymentAccountsModule`. |
| [src/modules/webhooks/webhooks.module.ts](src/modules/webhooks/webhooks.module.ts) | Swap `LoanRepaymentAccountsModule` → `UserRepaymentAccountsModule`. |
| [src/modules/webhooks/palmpay.webhook.controller.ts](src/modules/webhooks/palmpay.webhook.controller.ts) | Rewrite `_handleCollectionNotification` per §5.1. Remove `LoanPartialRepaymentUnsupportedException` catch — partial is now supported. |
| [src/modules/webhooks/blink.webhook.controller.ts](src/modules/webhooks/blink.webhook.controller.ts) | Extend collateral handler to recognize `CollateralTopUp` receiving_addresses per §6.2. |
| [src/common/errors/bitmonie.errors.ts](src/common/errors/bitmonie.errors.ts) | Remove `LoanPartialRepaymentUnsupportedException`. Add: `LoanNotActiveException`, `AddCollateralAlreadyPendingException`, `NoUnmatchedInflowException`, `InflowBelowFloorException`. |
| [workers/liquidation-monitor.worker.ts](workers/liquidation-monitor.worker.ts) | Replace fixed-threshold check with live accrual-aware check per §7. |
| [workers/loan-expiry.worker.ts](workers/loan-expiry.worker.ts) | Extend: ACTIVE loans past `due_at + 7d` → liquidate. Keep existing PENDING_COLLATERAL → EXPIRED behavior. |
| `workers/loan-reminder.worker.ts` | **New worker**. Reminder cadence per §8.3. |
| [test/postman/bitmonie.postman_collection.json](test/postman/bitmonie.postman_collection.json) | Update PalmPay collection webhook body (remove `accountReference`). Add add-collateral + claim-inflow requests. |
| [scripts/provision-repayment-account.ts](scripts/provision-repayment-account.ts) | Takes `--user-id`, calls `ensureForUser`. |
| `test/unit/loans/accrual.service.spec.ts` | **New**. Cover: zero-repayment, single partial, multiple partials, waterfall correctness, day-boundary edge cases, overpay. |
| `test/unit/loans/calculator.service.spec.ts` | Rewrite. New result shape. |
| `test/integration/loans/partial-repayment.spec.ts` | **New**. End-to-end: webhook → credit → status log → outstanding matches expected. |
| `test/integration/loans/add-collateral.spec.ts` | **New**. Endpoint → invoice → webhook → collateral_amount_sat incremented. |

**Definition of done additions (beyond CLAUDE.md §12):**
- Accrual engine 100% unit-tested (pure function — no excuse).
- Property-based tests on waterfall: sum of applied_to_* always equals amount_ngn − overpay_ngn.
- Liquidation monitor integration test with an accruing loan — threshold crosses after N days of interest accrual.

---

## 15. Open questions

All resolved during this session:
- ~~USD rate for `initial_collateral_usd`~~ → Blink BTC/USD rate, not Quidax cross-rate (see §4).
- ~~Day-boundary on same-day repayment~~ → full day always (see §3).
- ~~Grace-period liquidation surplus~~ → inherits existing liquidation behavior; interest + custody continue to accrue normally through the full 7-day grace (see §8.2).
- ~~Custody floor at small collateral values~~ → no floor; the `ceil($collateral_usd / 100) × 100` rule already yields N100/day minimum for any sub-$100 collateral.
- ~~Reminder email infrastructure~~ → extend existing `EmailProvider` with `sendTransactional(...)`, keep templates hardcoded per-provider for v1.1, migrate to provider-native templating in v1.2 (see §8.3).

No open questions blocking implementation.

---

## 16. What's NOT in this design (explicit deferrals)

- **SAT-based repayments.** `REPAYMENT_RECEIVED_SAT` reason code and its code path stay out. Repayment is NGN-only in v1.1.
- **Collateral release back to customer on REPAID.** Still a `// TODO` — separate SAT-outflow concern. Will ship in the same cycle but is orthogonal to this spec.
- **Card-payment path** (PalmPay checkout-link).
- **Ops dashboard for unmatched-inflow queue.** v1.1 alerts ops via email (existing `INTERNAL_ALERT_EMAIL`); the queue UI is v1.2.
- **Admin claim override endpoint.** §10.2 describes it but implementation is v1.2.
- **Naira wallet + yield** — v2, explicit.
- **Compounding interest / interest on fees.** Simple interest on principal only, by explicit decision (Q2 answer).
- **Loan extensions beyond the 7-day grace.** Grace is grace; past it, liquidate.
- **Provider-native email templating.** v1.1 uses hardcoded-per-provider template strings (same pattern as today's OTP emails). v1.2 migrates to Mailgun Templates / Postmark TemplateAlias / Resend React Email once the template count justifies the infrastructure.

---

## 17. CLAUDE.md updates required

Once this ships, update in a single commit:

- **§2 scope table**: remove "partial repayments" and "loan extensions" (the 7-day grace is not an extension in the spec sense) from the deferred list. Add "add-collateral" to the in-scope modules.
- **§5.4 liquidation math**: switch to the accrual-aware formula.
- **§6 state machine**: document ACTIVE → ACTIVE self-transitions for partial repayment + top-up, with required `loan_status_logs` row.
- **§9 constants**: swap old fee constants for the new ones per §13.
- **§10 fee calculation**: rewrite. Replace the single worked example with (a) origination, (b) daily accrual, (c) reducing-balance partial example (mirror §3 of this doc).
- **§11 development order**: already mostly applies; add `accrual.service.ts` as a phase-6 dependency of calculator, and partial-repayment + add-collateral as sub-phases under 9–10.
- Memory pointer `project_loan_v1_1_pricing.md` can be deleted once CLAUDE.md is updated (since CLAUDE.md becomes the source of truth again).
