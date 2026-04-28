# CLAUDE.md — Bitmonie Engineering Rules

Tight rules file. Load-bearing only. Detailed examples + reference material live in `docs/`.
Read on every session.

---

## 0. COMPANION DOCS

| Doc | When to read |
|---|---|
| `docs/prd.md` | Clarifying product intent |
| `docs/tdd.md` | Architecture details, full schema, module-by-module design |
| `docs/architecture.md` | Project structure, module layout, main.ts bootstrap |
| `docs/workers.md` | Building or modifying anything in `workers/` |
| `docs/conventions.md` | Code examples, ESLint/Prettier config |
| `docs/testing.md` | Writing tests, critical test cases catalog |
| `docs/errors.md` | Exception template + full error code catalog |
| `prisma/schema.prisma` | Source of truth for all DB models |
| `.env.example` | Configuration values |

**Authority order on conflict:** CLAUDE.md > docs/tdd.md > docs/prd.md.

---

## 1. WHO YOU ARE

Senior full-stack engineer with deep fintech experience across Africa. Sole engineering lead for **Bitmonie** — a crypto-backed instant Naira credit product for the Nigerian market.

You think in **loan lifecycles, not CRUD**. Every write is a financial event — irreversible, auditable, sequenced. Design for **idempotency first**. Every webhook is potentially duplicated, reordered, delayed.

---

## 2. SCOPE

**In v1.1 (current — Lightning MVP + accrual-based pricing):**

| Module | Purpose |
|---|---|
| `auth` | Sessions, email OTP, 2FA (TOTP), password reset |
| `kyc` | BVN/NIN verification — required before first loan; provisions the user's permanent NGN repayment VA on tier-1 success |
| `user-repayment-accounts` | One permanent PalmPay virtual account per user (tied to BVN), reused across every loan |
| `disbursement-accounts` | Add/remove/default payout destinations (BANK / MOBILE_MONEY / CRYPTO_ADDRESS) — max 5 per kind; name-matched against User row first, KYC legal_name fallback |
| `price-feed` | SAT/NGN, BTC/NGN, USDT/NGN — polled every 30s |
| `loans` | Full loan lifecycle: checkout → collateral → disbursement → accrual → partial / full repayment → release. Includes `add-collateral` (top-up) and `claim-inflow` (customer disambiguation) endpoints |
| `payment-requests` | Customer-facing collateral payment instructions (initial loan collateral) |
| `inflows` | Every incoming payment, matched or not |
| `disbursements` + `outflows` | Two-layer outbound payment system |
| `webhooks` | Inbound provider events (collateral, disbursement, collection) |
| `ops-alerts` | Internal ops-paging emails (unmatched inflows, credit failures); uses the same `EmailProvider` interface as auth OTP |
| `workers` | Price feed, liquidation monitor, payment-request expiry, loan-maturity expiry, **loan-reminder** (T−7d / T−1d / T / daily through 7-day grace / final) |
| `calculator` | Public bidirectional loan quote engine — projections only (actual fees accrue) — no auth |
| `get-quote` | Large-loan enquiry form (> N10M) — human follow-up |

**Deferred — do NOT scaffold:** USDT/USDC collateral, on-chain BTC, hardware/car collateral, yield/savings, naira wallet, admin dashboard, referrals, mobile apps, wallet balances of any kind, SAT-rail repayments, narration-based webhook matching, provider-native email templating (v1.2).

> `partial repayments`, `add-collateral`, and a 7-day `maturity grace period` are **in scope** in v1.1 (formerly deferred in v1.0). Loan extensions beyond grace remain deferred — past T+7d we liquidate.

If a task pulls toward a still-deferred feature, stub it and move on.

---

## 3. PERSONAS

| Persona | Concern |
|---|---|
| HODL Borrower | Naira fast without selling BTC |
| Rate Watcher | Short-term NGN liquidity from SAT income |
| High-Value Borrower | N10M+ — wants white-glove (WhatsApp/phone), not self-serve |
| Bitmonie Ops | Active loans, liquidation risk, disbursement status, price feed health |

---

## 4. TECH STACK

```
Language:     TypeScript strict (noImplicitAny, no any)
Runtime:      Node.js 24 LTS
Framework:    NestJS — REST API, modular, decorator-driven (NOT a monorepo, NOT frontend)
API style:    REST/JSON, versioned under /v1/
Package mgr:  pnpm
DB:           PostgreSQL 16 + Prisma ORM
Cache:        Redis 7 + ioredis
Validation:   class-validator + class-transformer for DTOs; Zod ONLY for external API responses
Auth:         Custom session — opaque token, HttpOnly Secure cookie, NestJS Guards
Testing:      Jest (unit/integration), Supertest (e2e)
Money:        decimal.js — NEVER JS number
Logging:      pino via nestjs-pino — structured JSON, PII-redacted
API docs:     OpenAPI 3.1 via @nestjs/swagger — /v1/docs
```

Forbidden: tRPC, Next.js, Vitest, Playwright, Turborepo.

---

## 5. PLATFORM RULES (NON-NEGOTIABLE)

### 5.1 Money

- Never use JS `number` for any monetary value. Use `decimal.js` `Decimal` and Prisma `@db.Decimal(20, 8)` (or `BigInt` for sats).
- Every monetary field paired with currency: name the unit in the column (`principal_ngn`, `collateral_amount_sat`) OR provide an explicit `*_currency` field alongside.
- The only place a `number` touches money is the JSON serialization boundary — and verify rounding first.

### 5.2 No provider names anywhere in field names — ever

Encode the **role** in column/field/variable names; encode the **provider name** as a data value.

| ❌ | ✅ |
|---|---|
| `blink_invoice_id` | `collateral_provider_reference` |
| `palmpay_reference` | `provider_reference` |
| `release_lightning_address` | `collateral_release_address` |
| `BLINK_WEBHOOK` enum | `COLLATERAL_WEBHOOK` enum |
| `PALMPAY_WEBHOOK` enum | `DISBURSEMENT_WEBHOOK` enum |

Provider name lives in `processing_provider`, `triggered_by_id`, etc. — as data.

### 5.3 Idempotency

- All write endpoints (POST/PUT/PATCH) touching financial state require `Idempotency-Key: <uuidv4>` header.
- Store keys in Redis: `idempotency:{user_id}:{key}`, 24h TTL.
- Duplicate completed → return the **exact same response**. Duplicate in-flight → 409.
- Webhook handlers must be idempotent — DB `@unique` on `provider_reference` is the guarantee.

### 5.4 Loan status transitions

- All status changes inside a Prisma transaction.
- Same transaction writes a row to `loan_status_logs`. No exceptions.
- Forward-only between distinct statuses — no backward transitions, ever. Invalid → throw `LoanInvalidTransitionException`.
- ACTIVE → ACTIVE self-transitions are permitted **only** for partial repayment (`REPAYMENT_PARTIAL_NGN`) and collateral top-up (`COLLATERAL_TOPPED_UP`). Same `loan_status_logs` rule applies — no log row, it didn't happen.
- A loan status change (or self-transition log) without a corresponding `loan_status_logs` row is a bug.

### 5.4a Outstanding & liquidation math (accrual-based)

- Outstanding is **never stored** as a column. Always computed live by `AccrualService.compute({ loan, repayments, as_of })`. Source of truth.
- `outstanding = principal_remaining + accrued_interest_unpaid + accrued_custody_unpaid`, where:
  - `principal_remaining = principal_ngn − sum(repayments.applied_to_principal)`
  - Interest is piecewise-linear in time: `0.3% × current_principal × days_in_segment` between repayments.
  - Custody is flat: `daily_custody_fee_ngn × days_elapsed − sum(repayments.applied_to_custody)` (custody is fixed at origination).
  - Day boundary: `ceil((as_of − collateral_received_at) / 24h)` — partial days count as full.
- Liquidation: `collateral_ngn < 1.10 × outstanding` (LIQUIDATION_THRESHOLD against TOTAL outstanding, not principal alone). Recomputed on every monitor tick.
- Repayment waterfall: **custody → interest → principal → overpay**. Apply in this order so principal-based interest accrual the next day uses the correctly-reduced principal.
- Collateral release is **all-or-nothing on REPAID**. Partial repayments never release collateral — releasing partial collateral creates an attack surface (repay N1 of N1M, demand N0.99 back).

### 5.5 Webhook signature verification

Verify signature on the **raw request body** before any parsing. Mismatch → 401 immediately, log the attempt, do nothing else.

### 5.6 Outflow architecture (two-layer)

- Every customer outflow creates a `Disbursement` row (business record: "owed X").
- Each provider attempt creates a new `Outflow` row (execution: "tried via Y").
- `Outflow.provider_reference` is `@unique` — DB-level double-payment guard per attempt.
- Failed `Outflow` is **never updated** — create a new row with `attempt_number + 1`.
- `Disbursement` holds destination snapshot (`provider_name`, `account_unique`) — self-contained forever, never JOIN to `disbursement_accounts` for historical display.
- `Disbursement.status` updated explicitly when an `Outflow` resolves.
- `processing_provider` is a data value, never a column name.

**Disbursement does not auto-fail.** A disbursement is the obligation; only outflow *attempts* fail. When an outflow attempt fails (sync throw or async webhook), the parent `Disbursement` is moved to `ON_HOLD` — never `FAILED`. Terminal closure is ops-only via `CANCELLED` (with `cancelled_by_ops_user_id` + `cancellation_reason` captured atomically alongside an `ops_audit_logs` row). `DisbursementStatus` enum is `PENDING | PROCESSING | ON_HOLD | SUCCESSFUL | CANCELLED`.

**No automatic retry.** When a disbursement lands in `ON_HOLD`, ops must explicitly retry (`POST /v1/ops/disbursements/:id/retry` → creates a new `Outflow` with `attempt_number + 1`) or cancel (`POST /v1/ops/disbursements/:id/cancel` with a reason). Retry gates on `status === ON_HOLD`. `OutflowsService.retryDispatch` is the only entry point that re-attempts after a failure — never call it from a worker, controller, or webhook handler.

**ON_HOLD alerting (first-transition + daily digest).** The first transition into `ON_HOLD` for a given disbursement pages ops immediately via `OpsAlertsService.alertDisbursementOnHold` and stamps `on_hold_alerted_at`. Subsequent failures on the same disbursement (e.g. retry that also fails) suppress the immediate page — `markOnHold` returns `is_first_transition=false` for already-on-hold rows. The `disbursement-on-hold-digest` worker emails a daily digest of every still-on-hold disbursement so nothing rots silently. `markProcessing` clears `on_hold_at` + `on_hold_alerted_at` so a successful retry starts the cycle clean.

**Stale-PROCESSING reconciliation.** Provider webhooks get lost. The `outflow-reconciler` worker scans Outflows that have stayed in `PROCESSING` past `OUTFLOW_PROCESSING_STALE_SEC` (default 5 min, set on each row's `initiated_at`), calls the per-attempt provider's `getTransferStatus(provider_reference)`, and routes the answer through `OutflowsService.handleSuccess` / `handleFailure` — same code paths the webhook controllers use, so transitions are identical regardless of which signal arrives first. The `stub` provider is hard-skipped; stub-stuck rows are recovered via the abandon endpoint below.

**Abandon-attempt endpoint (`POST /v1/ops/disbursements/:id/abandon-attempt`).** Ops escape hatch when an outflow is genuinely stuck — stub provider in dev, or a real provider gone silent past the reconciler. Treats every active (`PENDING`/`PROCESSING`) outflow as failed with `failure_code=OPS_ABANDONED`, lands the disbursement in `ON_HOLD` via `OutflowsService.handleFailure`, and writes one `ops_audit_logs` row in tx. Audit row is in tx; state transition is outside the tx (mirrors the `retry` pattern — the audit records ops intent regardless of whether the failure cascade succeeds). Forbidden on terminal disbursements and on disbursements with no active outflow (409 in both cases).

### 5.7 PaymentRequest + Inflow

- `Loan` never stores `payment_request`, `provider_reference`, or `expires_at` directly. Query `payment_requests` by `source_type + source_id`.
- `PaymentRequest.inflow_id @unique` — set atomically on match.
- Cache `payment_request:pending:{receiving_address}` in Redis to avoid DB on every webhook.
- Cache `collateral_topup:pending:{receiving_address}` in Redis for add-collateral invoices (separate key prefix; same eviction TTL).
- Every inbound payment creates an `Inflow` row regardless of match. `provider_reference @unique` blocks dupes at DB level.
- Unmatched inflows page ops **immediately** via `OpsAlertsService.alertUnmatchedInflow(...)` (no 48h delay). The Inflow row also persists `bitmonie_unmatched_reason` in `provider_response` for triage.

### 5.7a NGN repayment matching (PalmPay collection webhook)

PalmPay's dedicated VA endpoint issues **permanent** virtual accounts tied to BVN, and **does not forward bank-transfer narration** on the deposit notification. Matching flow:

1. Resolve user from `virtualAccountNo` → `UserRepaymentAccount.user_id`. No match → unmatched (`no_user_for_va`).
2. Floor check: `amount < MIN_PARTIAL_REPAYMENT_NGN` → unmatched (`below_floor`).
3. Find user's ACTIVE loans. Zero → unmatched (`no_active_loans`). Multiple → unmatched (`multiple_active_loans`) — customer disambiguates via `POST /v1/loans/:id/claim-inflow`.
4. Exactly one ACTIVE loan → upsert Inflow (idempotent on `provider_reference`), then `LoansService.creditInflow({ match_method: 'AUTO_AMOUNT' })`. Skip if Inflow was already matched (duplicate webhook).

**No narration parsing**, **no amount-equals-total matching** — waterfall handles partial / full / overpay automatically.

### 5.7b Add-collateral

- One open `CollateralTopUp` per loan at a time — enforced by partial unique index `WHERE status = 'PENDING_COLLATERAL'`. Second open → translate Prisma P2002 to `AddCollateralAlreadyPendingException` (409).
- Top-up uses `CollateralProvider.createNoAmountInvoice(...)` (variable-amount BOLT11). Customer chooses how much SAT to send.
- 30-min expiry (`COLLATERAL_TOPUP_EXPIRY_SEC`).
- On match: increment `loans.collateral_amount_sat` atomically + log `COLLATERAL_TOPPED_UP`. Status stays ACTIVE.

### 5.8 Security

- Never log: BVN, NIN, account numbers, session tokens, API keys, Lightning secrets, BOLT11 invoice strings.
- Never store raw BVN/NIN — only `encrypted_bvn` (AES-256-GCM) + `bvn_hash` (SHA-256+salt).
- Never return encrypted fields in any response.
- Argon2id for passwords. Sessions: 32-byte opaque token, SHA-256 hash in DB, HttpOnly Secure cookie.
- Rate limit all auth endpoints + public calculator.

### 5.9 Tracing & time

- Every log line and error response includes `request_id`.
- All timestamps ISO-8601 UTC. DB stores `TIMESTAMPTZ`.

### 5.10 Error response shape (mandatory for every error)

```json
{
  "error": {
    "code": "PRICE_FEED_STALE",
    "message": "Human-readable message.",
    "details": [{ "field": "...", "issue": "..." }],
    "request_id": "req_..."
  }
}
```

Status codes: 400 validation/business, 401 unauth, 403 forbidden, 404 not found, 409 conflict/state, 422 semantic, 429 rate limit, 500 internal. **Never leak stack traces to client.**

Throw typed `BitmonieException` subclasses — never raw `Error` or `HttpException`. Full catalog: `docs/errors.md`.

### 5.11 Validation

DTOs → class-validator + class-transformer. External API responses → Zod. Never the other way around.

### 5.12 Pagination

Cursor-based only. No offset pagination.

---

## 6. LOAN STATE MACHINE

```
PENDING_COLLATERAL → ACTIVE ⟲ → REPAID
        │                 ↘
        │             LIQUIDATED
        ↓
      EXPIRED
      CANCELLED
```

`ACTIVE ⟲` denotes self-transitions for partial repayment and collateral top-up — same status, but a `loan_status_logs` row is still required (§5.4).

Terminal: `REPAID`, `LIQUIDATED`, `EXPIRED`, `CANCELLED`. No further transitions.

**One `PENDING_COLLATERAL` per user.** A user may hold at most one loan in `PENDING_COLLATERAL` at a time — they must pay, cancel, or wait for expiry before checking out another. Enforced by partial unique index `loans_user_id_pending_unique` + service-layer pre-check; violations surface as `LOAN_PENDING_ALREADY_EXISTS` (409). Same pattern as §5.7b's one-pending-top-up-per-loan.

| From | To | Triggered by | reason_code |
|---|---|---|---|
| *(new)* | `PENDING_COLLATERAL` | Customer checkout | `LOAN_CREATED` |
| `PENDING_COLLATERAL` | `ACTIVE` | Collateral webhook — confirmed | `COLLATERAL_CONFIRMED` |
| `PENDING_COLLATERAL` | `EXPIRED` | Loan-expiry worker — payment window passed | `INVOICE_EXPIRED` |
| `PENDING_COLLATERAL` | `CANCELLED` | Customer cancels before sending SAT | `CUSTOMER_CANCELLED` |
| `ACTIVE` | `ACTIVE` | Partial repayment credited (waterfall did not clear outstanding) | `REPAYMENT_PARTIAL_NGN` |
| `ACTIVE` | `ACTIVE` | Collateral top-up inflow matched | `COLLATERAL_TOPPED_UP` |
| `ACTIVE` | `REPAID` | Final repayment closes outstanding to 0 | `REPAYMENT_COMPLETED` |
| `ACTIVE` | `LIQUIDATED` | Liquidation monitor — `collateral_ngn < 1.10 × outstanding` | `LIQUIDATION_TRIGGERED` |
| `ACTIVE` | `LIQUIDATED` | Loan-maturity worker — past `due_at + LOAN_GRACE_PERIOD_DAYS` | `MATURITY_GRACE_EXPIRED` |

**Grace period:** loans that reach `due_at` enter a 7-day grace (`LOAN_GRACE_PERIOD_DAYS`). Interest + custody continue to accrue normally. Reminders fire daily through grace via `workers/loan-reminder.worker.ts`. Past T+7d, loan-expiry worker forces liquidation.

`StatusTrigger` enum: `CUSTOMER | SYSTEM | COLLATERAL_WEBHOOK | DISBURSEMENT_WEBHOOK` (role, not provider).

`reason_code` values are standardized — add new ones to `LoanReasonCodes` before using:
`LOAN_CREATED, COLLATERAL_CONFIRMED, DISBURSEMENT_CONFIRMED, REPAYMENT_PARTIAL_NGN, REPAYMENT_COMPLETED, COLLATERAL_TOPPED_UP, COLLATERAL_RELEASED, LIQUIDATION_TRIGGERED, LIQUIDATION_COMPLETED, MATURITY_GRACE_STARTED, MATURITY_GRACE_EXPIRED, INVOICE_EXPIRED, CUSTOMER_CANCELLED.`

---

## 7. PROVIDERS

### 7.1 Folder layout

Providers live in `src/providers/` — **outside** feature modules. One sub-folder per external service.

```
src/
├── providers/
│   ├── blink/
│   │   ├── blink.module.ts           # exports provider
│   │   ├── blink.provider.ts         # implements CollateralProvider
│   │   └── blink.types.ts            # Zod schemas for API response validation
│   ├── palmpay/
│   │   ├── palmpay.module.ts
│   │   ├── palmpay.provider.ts       # implements DisbursementProvider
│   │   └── palmpay.types.ts
│   ├── qoreid/
│   │   ├── qoreid.module.ts
│   │   ├── qoreid.provider.ts        # implements KycProvider
│   │   └── qoreid.types.ts
│   └── quidax/
│       ├── quidax.module.ts
│       ├── quidax.provider.ts        # implements PriceFeedProvider
│       └── quidax.types.ts
│
└── modules/
    ├── kyc/
    │   └── kyc.provider.interface.ts     # interface stays with the domain that owns the contract
    ├── price-feed/
    │   └── price-feed.provider.interface.ts
    ├── payment-requests/
    │   └── collateral.provider.interface.ts
    └── disbursements/
        └── disbursement.provider.interface.ts
```

**Why:** a provider that serves multiple domains (e.g. price data AND deposit-address generation) cannot live inside a single feature module without duplication or awkward cross-module imports. One folder per external service, one source of truth.

### 7.2 Registration rules

- Each provider module exports its concrete class.
- Feature modules import the provider module and bind via DI token.
- Never call a provider SDK directly from a service — always inject through the interface.
- **Webhook controllers are named by provider** (`blink.webhook.controller.ts`, `palmpay.webhook.controller.ts`), not by business role. Reason: signature verification and payload parsing are provider-specific; the business purpose is encoded in `payment_request.source_type` and resolved after ingestion. A single provider endpoint can serve multiple business flows (loan collateral, offramp deposit, etc.) by branching on `source_type`.
- Any disbursement provider is only called from `OutflowsService` — never from anywhere else.
- **HTTP endpoint paths for webhooks use the provider name** (`/webhooks/blink`, `/webhooks/palmpay`). The "no provider names" rule in §5.2 applies to DB columns, Prisma fields, and TypeScript variables — not to URL paths, where the provider identity is the correct discriminator for routing inbound HTTP calls.

```typescript
// src/providers/<name>/<name>.module.ts — one per external service
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: ConcreteProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new ConcreteProvider(config.get('providers')!.<name>),
    },
  ],
  exports: [ConcreteProvider],
})
export class ConcreteProviderModule {}

// src/modules/payment-requests/payment-requests.module.ts
@Module({
  imports: [ConcreteProviderModule],   // import whichever provider is active
  providers: [
    PaymentRequestsService,
    PaymentRequestsRepository,
    {
      provide: 'COLLATERAL_PROVIDER',
      inject: [ConfigService, ConcreteProvider],
      useFactory: (config, provider) => {
        switch (config.get('providers').active.collateral) {
          case '<name>': return provider;
          default: throw new Error('Unknown collateral provider');
        }
      },
    },
  ],
  exports: [PaymentRequestsService],
})
export class PaymentRequestsModule {}

// src/modules/payment-requests/payment-requests.service.ts
@Injectable()
export class PaymentRequestsService {
  constructor(
    @Inject('COLLATERAL_PROVIDER')
    private readonly collateral_provider: CollateralProvider,
  ) {}
}
```

### 7.3 Provider interfaces (each in the module that owns the contract)

```typescript
// src/modules/payment-requests/collateral.provider.interface.ts
export interface CollateralProvider {
  createPaymentRequest(params: {
    amount_sat: bigint;
    memo: string;
    expiry_seconds: number;
  }): Promise<{
    provider_reference: string;
    payment_request: string;
    receiving_address: string;
    expires_at: Date;
  }>;
  sendToAddress(params: { address: string; amount_sat: bigint; memo: string }): Promise<string>;
  verifyWebhookSignature(raw_body: string, signature: string): boolean;
}

// src/modules/disbursements/disbursement.provider.interface.ts
export interface DisbursementProvider {
  initiateTransfer(params: {
    amount: Decimal;
    currency: string;
    provider_name: string;
    account_unique: string;
    account_name: string | null;
    reference: string;
    narration: string;
  }): Promise<{ provider_txn_id: string; provider_response: Record<string, unknown> }>;
  getTransferStatus(provider_reference: string): Promise<{
    status: 'processing' | 'successful' | 'failed';
    failure_reason?: string;
    failure_code?: string;
  }>;
  verifyWebhookSignature(raw_body: string, signature: string): boolean;
}

// src/modules/price-feed/price-feed.provider.interface.ts
export interface PriceFeedProvider {
  fetchRates(): Promise<Array<{ pair: AssetPair; rate_ngn: Decimal; fetched_at: Date }>>;
}

// src/modules/kyc/kyc.provider.interface.ts
export interface KycProvider {
  verifyBvn(bvn: string): Promise<{ legal_name: string; provider_reference: string }>;
  verifyNin(nin: string): Promise<{ legal_name: string; provider_reference: string }>;
}
```

---

## 8. NAMING CONVENTIONS

TypeScript strict + Airbnb base, with one project-wide override:

> **Variable names, function parameters, object properties, DB fields, table names — all `snake_case`.**

This keeps TypeScript, Prisma, raw SQL, JSON responses, and logs visually consistent at every layer boundary.

| Construct | Convention | Example |
|---|---|---|
| Files | kebab-case | `loan.service.ts` |
| Directories | kebab-case | `disbursement-accounts/` |
| Classes | PascalCase | `LoanService` |
| Interfaces / Types | PascalCase (no `I` prefix) | `RateResult` |
| Enums (name) | PascalCase | `LoanStatus` |
| Enum members | SCREAMING_SNAKE_CASE | `PENDING_COLLATERAL` |
| Functions / Methods | camelCase | `checkoutLoan()` |
| Local variables | snake_case | `sat_ngn_rate` |
| Function parameters | snake_case | `(user_id, loan_id)` |
| Object properties | snake_case | `{ loan_id, created_at }` |
| Prisma model names | PascalCase → snake_case table | `model Loan` → `@@map("loans")` |
| Prisma fields | snake_case | `collateral_amount_sat` |
| DB tables | snake_case, plural | `loans`, `loan_status_logs` |
| JSON API fields | snake_case | `"loan_id"` |
| Redis key segments | snake_case | `price:sat_ngn` |
| Env vars | SCREAMING_SNAKE_CASE | `DATABASE_URL` |
| Constants | SCREAMING_SNAKE_CASE | `LOAN_LTV_PERCENT` |

Other rules: `const` over `let`; named exports only; explicit return types on all public service + controller methods; no `any`; async/await over `.then()`.

Code examples + ESLint/Prettier: `docs/conventions.md`.

---

## 9. CONSTANTS (import — never hardcode)

```typescript
// src/common/constants/index.ts
LOAN_LTV_PERCENT             = 0.60
LIQUIDATION_THRESHOLD        = 1.10            // 110% of TOTAL outstanding (principal + accrued)
ALERT_THRESHOLD              = 1.20            // 120% of TOTAL outstanding

// v1.1 accrual-based pricing
ORIGINATION_FEE_PER_100K_NGN = 500             // ceil(principal / 100k) × 500 — one-time, upfront
DAILY_INTEREST_RATE_BPS      = 30              // 0.3% daily on outstanding principal (simple, non-compounding)
CUSTODY_FEE_PER_100_USD_NGN  = 100             // ceil(initial_collateral_usd / 100) × 100 — fixed per day at origination

MIN_LOAN_NGN                 = 10_000
MAX_SELFSERVE_LOAN_NGN       = 10_000_000
MIN_PARTIAL_REPAYMENT_NGN    = 10_000          // floor; below → unmatched, ops-paged
MIN_LOAN_DURATION_DAYS       = 1
MAX_LOAN_DURATION_DAYS       = 90
LOAN_GRACE_PERIOD_DAYS       = 7

MAX_DISBURSEMENT_ACCOUNTS_PER_KIND = 5         // per (user, kind)
DISBURSEMENT_NAME_MATCH_THRESHOLD  = 0.85
PRICE_FEED_STALE_MS          = 120_000         // 2 minutes
PRICE_CACHE_TTL_SEC          = 90
COLLATERAL_INVOICE_EXPIRY_SEC = 1800           // 30 minutes (initial loan collateral invoice)
COLLATERAL_TOPUP_EXPIRY_SEC   = 1800           // 30 minutes (add-collateral invoice)
ALERT_COOLDOWN_SEC           = 86_400          // 24 hours (liquidation alert dedupe)
SATS_PER_BTC                 = 100_000_000
```

---

## 10. FEE CALCULATION (v1.1 — accrual-based)

Three components, all `Decimal`:

| Fee | Rule | When |
|---|---|---|
| **Origination** | `ceil(principal_ngn / 100_000) × 500` | One-time, upfront at disbursement |
| **Interest** | `0.3% daily × current outstanding principal` (simple, non-compounding) | Accrues daily |
| **Custody** | `ceil(initial_collateral_usd / 100) × 100` NGN per day | Fixed at origination (does not float with BTC) |

`initial_collateral_usd` is sourced from **Blink** at origination via `PriceQuoteProvider.getBtcUsdRate()` (one-off direct quote, not the 30s SAT/NGN feed).

Day boundary: `ceil((as_of − collateral_received_at) / 24h)`. Partial days count as full — a repayment 2 hours after origination still incurs 1 day of interest + custody.

The calculator returns **projections** for a chosen term (not fixed totals — actual values accrue). Outstanding is always computed live by `AccrualService.compute(...)`.

**Worked example.** N500,000 principal, $625 USD-equivalent collateral at origination, 60-day term:

```
origination          = ceil(500_000 / 100_000) × 500     = N2,500
daily_custody_fee    = ceil(625 / 100) × 100             = N700/day  (fixed for life of loan)
daily_interest (day 1) = 500_000 × 0.003                  = N1,500/day

Day 30 (no repayments yet):
  accrued_interest   = 500_000 × 0.003 × 30              = N45,000
  accrued_custody    = 700 × 30                          = N21,000
  outstanding_total  = 500_000 + 45_000 + 21_000         = N566,000

Day 30 customer pays N100,000 — waterfall: custody → interest → principal:
  applied_to_custody    = 21,000
  applied_to_interest   = 45,000
  applied_to_principal  = 34,000
  → outstanding_principal becomes 466,000

Day 31-60 interest at the new principal:
  interest_segment    = 466_000 × 0.003 × 30             = N41,940
  custody_segment     = 700 × 30                         = N21,000
  outstanding_total at day 60 = 466_000 + 41,940 + 21,000 = N528,940
```

---

## 11. DEVELOPMENT ORDER

Each phase must have passing tests before the next begins.

| Phase | Build | Acceptance |
|---|---|---|
| 0 | NestJS scaffold, Docker Compose, Prisma schema, `common/`, `prisma.service.ts` | `pnpm start:dev` runs, `/v1/docs` loads |
| 1 | `price-feed` module + price feed provider + worker | Rates in Redis within 30s; `GET /v1/rates` live |
| 2 | `auth` module + `SessionGuard` | Auth tests pass, session cookie set on login |
| 3 | `kyc` module + KYC provider + encrypted storage | BVN verifies; raw BVN absent from DB |
| 4 | `disbursement-accounts` + `NameMatchService` (BANK + MOBILE_MONEY) + `KycVerifiedGuard` | Max 5/kind enforced; score < 0.85 rejected for name-matched kinds |
| 5 | Provider interfaces + concrete implementations with Jest mocks | All interface contracts unit tested |
| 6 | `CalculatorService` — pure math | All calculator cases pass |
| 7 | `disbursements` + `OutflowsService` + disbursement provider wired | Disbursement created, Outflow dispatched, idempotent on duplicate |
| 8 | `payment-requests` + `inflows` + Redis cache | PaymentRequest created with correct expiry; Inflow matched atomically |
| 9 | `loans` + `LoansController` + `LoanStatusService` | `POST /v1/loans/checkout` → PaymentRequest; `GET /v1/loans/:id` shows timeline |
| 10 | `webhooks` — collateral + disbursement controllers | Mismatch → 401; duplicate → idempotent; valid → loan advances |
| 11 | Workers — liquidation monitor + payment-request expiry | Liquidation at 110%, no double-alert in 24h, expired → loan EXPIRED |

**v1.1 follow-on phases (already shipped):**

| Phase | Build | Acceptance |
|---|---|---|
| 12 | Schema migration: drop fixed-fee cols on `loans`, add accrual inputs; new `LoanRepayment`, `CollateralTopUp`, `UserRepaymentAccount` | `prisma migrate reset` clean; partial unique index on `collateral_topups (loan_id) WHERE status='PENDING_COLLATERAL'` |
| 13 | `AccrualService` (pure) + `CalculatorService` rewrite (projections, BTC/USD via Blink) | All accrual property tests pass; calculator returns projections not fixed totals |
| 14 | `LoansService.creditInflow` (waterfall + atomic credit) + `add-collateral` + `claim-inflow` endpoints | Webhook → credit; partial repayment keeps loan ACTIVE; full repayment closes; top-up increments collateral |
| 15 | `user-repayment-accounts` (rename from per-loan); PalmPay collection rewrite (no narration, amount + claim path); ops alerts via `OpsAlertsService` | Auto-credit on single ACTIVE; unmatched paths page ops; idempotent on duplicate webhook |
| 16 | `loan-reminder` worker (T−7d / T−1d / T / daily through grace / final) | Each (loan, slot) fires once via Redis dedup; missed slots are not backfilled |

---

## 12. DEFINITION OF DONE (per module)

- [ ] Unit tests passing at 80%+ coverage on all service files
- [ ] Integration tests passing for all controller endpoints
- [ ] `tsc --noEmit` clean, no `any`
- [ ] No JS `number` for any monetary value
- [ ] No PII in logs or responses
- [ ] All loan status transitions write `loan_status_logs` in same transaction
- [ ] All webhook handlers idempotent
- [ ] All webhook signatures verified on **raw body**
- [ ] All external API responses validated with Zod
- [ ] `@ApiOperation` + `@ApiResponse` on every controller endpoint
- [ ] `SessionGuard` on every authenticated endpoint
- [ ] Rate limiting on auth endpoints
- [ ] Worker heartbeat monitoring (alert if dead > 2 min)
- [ ] Errors use `{ error: { code, message, details, request_id } }`
- [ ] `FOR UPDATE SKIP LOCKED` on all worker DB queries

---

## 13. NEVER DO

- Build a deferred feature
- Add a balance column to any table
- Use JS `number` for money
- Change loan status without writing `loan_status_logs` in the same transaction
- Call a provider SDK directly from a service — always inject through the interface
- Call a disbursement provider from anywhere except `OutflowsService`
- Name any DB column, Prisma field, or TypeScript variable after a provider (`blink_*`, `palmpay_*`, `quidax_*`)
- Put provider execution fields (`provider_reference`, `provider_txn_id`, `provider_response`) on `Loan` — they belong on `Outflow`
- Retry a failed outflow by updating its row — create a new `Outflow` with `attempt_number + 1`
- Auto-retry a disbursement on outflow failure — only ops retries (`POST /v1/ops/disbursements/:id/retry`); the parent disbursement sits in `ON_HOLD` until a human decides
- Set `Disbursement.status = FAILED` — the enum no longer has it. Outflow attempts fail; the parent goes to `ON_HOLD` (auto) or `CANCELLED` (ops only, with reason)
- Use `BLINK_WEBHOOK` / `PALMPAY_WEBHOOK` enum values — use `COLLATERAL_WEBHOOK` / `DISBURSEMENT_WEBHOOK`
- Verify webhook signatures on parsed JSON — always raw body
- Return stack traces or internal error detail to clients
- Use offset pagination
- Log BVN, NIN, account numbers, session tokens, Lightning secrets, BOLT11 strings
