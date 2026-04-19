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

**In v1.0 (Lightning MVP):**

| Module | Purpose |
|---|---|
| `auth` | Sessions, email OTP, 2FA (TOTP), password reset |
| `kyc` | BVN/NIN verification — required before first loan |
| `disbursement-accounts` | Add/remove/default payout destinations (BANK / MOBILE_MONEY / CRYPTO_ADDRESS) — max 5 per kind; name-matched against BVN for BANK + MOBILE_MONEY |
| `price-feed` | SAT/NGN, BTC/NGN, USDT/NGN — polled every 30s |
| `loans` | Full loan lifecycle: checkout → collateral → disbursement → repayment → release |
| `payment-requests` | Customer-facing payment instructions (collateral receipt) |
| `inflows` | Every incoming payment, matched or not |
| `disbursements` + `outflows` | Two-layer outbound payment system |
| `webhooks` | Inbound provider events (collateral, disbursement) |
| `workers` | Price feed, liquidation monitor, payment-request expiry |
| `calculator` | Public bidirectional loan quote engine — no auth |
| `get-quote` | Large-loan enquiry form (> N10M) — human follow-up |

**Deferred — do NOT scaffold:** USDT/USDC collateral, on-chain BTC, hardware/car collateral, yield/savings, loan extensions, partial repayments, admin dashboard, referrals, mobile apps, wallet balances of any kind.

If a task pulls toward a deferred feature, stub it and move on.

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
- Forward-only — no backward transitions, ever. Invalid → throw `LoanInvalidTransitionException`.
- A loan status change without a corresponding log row is a bug.

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

### 5.7 PaymentRequest + Inflow

- `Loan` never stores `payment_request`, `provider_reference`, or `expires_at` directly. Query `payment_requests` by `source_type + source_id`.
- `PaymentRequest.inflow_id @unique` — set atomically on match.
- Cache `payment_request:pending:{receiving_address}` in Redis to avoid DB on every webhook.
- Every inbound payment creates an `Inflow` row regardless of match. `provider_reference @unique` blocks dupes at DB level.
- Unmatched inflows alert ops after 48h — never silently dropped.

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
    "code": "LOAN_PRICE_STALE",
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
PENDING_COLLATERAL → ACTIVE → REPAID
        │                 ↘
        │             LIQUIDATED
        ↓
      EXPIRED
      CANCELLED
```

Terminal: `REPAID`, `LIQUIDATED`, `EXPIRED`, `CANCELLED`. No further transitions.

| From | To | Triggered by |
|---|---|---|
| *(new)* | `PENDING_COLLATERAL` | Customer checkout |
| `PENDING_COLLATERAL` | `ACTIVE` | Collateral webhook — confirmed |
| `PENDING_COLLATERAL` | `EXPIRED` | Loan expiry worker — payment window passed |
| `PENDING_COLLATERAL` | `CANCELLED` | Customer cancels before sending SAT |
| `ACTIVE` | `REPAID` | Customer repays in full (NGN or SAT) |
| `ACTIVE` | `LIQUIDATED` | Liquidation monitor — collateral < 110% of principal |

`StatusTrigger` enum: `CUSTOMER | SYSTEM | COLLATERAL_WEBHOOK | DISBURSEMENT_WEBHOOK` (role, not provider).

`reason_code` values are standardized — add new ones to `LoanReasonCodes` before using:
`LOAN_CREATED, COLLATERAL_CONFIRMED, DISBURSEMENT_CONFIRMED, REPAYMENT_RECEIVED_NGN, REPAYMENT_RECEIVED_SAT, COLLATERAL_RELEASED, LIQUIDATION_TRIGGERED, LIQUIDATION_COMPLETED, INVOICE_EXPIRED, CUSTOMER_CANCELLED.`

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
- Webhook controllers named by **role** (`collateral.webhook.controller.ts`), not provider.
- Any disbursement provider is only called from `OutflowsService` — never from anywhere else.

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
LOAN_LTV_PERCENT          = 0.80
LIQUIDATION_THRESHOLD     = 1.10            // 110% of principal
ALERT_THRESHOLD           = 1.20            // 120% of principal
ORIGINATION_FEE_NGN       = 500
DAILY_FEE_PER_100_NGN     = 500             // N500 per $100/day
MIN_LOAN_NGN              = 50_000
MAX_SELFSERVE_LOAN_NGN    = 10_000_000
MIN_LOAN_DURATION_DAYS    = 1
MAX_LOAN_DURATION_DAYS    = 30
MAX_DISBURSEMENT_ACCOUNTS_PER_KIND = 5      // per (user, kind)
DISBURSEMENT_NAME_MATCH_THRESHOLD  = 0.85
PRICE_FEED_STALE_MS       = 120_000         // 2 minutes
PRICE_CACHE_TTL_SEC       = 90
BLINK_INVOICE_EXPIRY_SEC  = 1800            // 30 minutes
ALERT_COOLDOWN_SEC        = 86_400          // 24 hours
SATS_PER_BTC              = 100_000_000
```

---

## 10. FEE CALCULATION

Fee model: **N500 per $100 USD equivalent per day**, plus N500 origination.

```
Example: N300,000 / 7 days @ N1,410/USDT
  usd_equivalent = 300_000 / 1_410       = $212.77
  fee_units      = ceil(212.77 / 100)    = 3
  daily_fee_ngn  = 3 * 500               = N1,500
  total_fees_ngn = (1_500 * 7) + 500     = N11,000
```

All arithmetic uses `Decimal`. Partial $100 unit is billed as a full unit (`ceil`).

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
- Use `BLINK_WEBHOOK` / `PALMPAY_WEBHOOK` enum values — use `COLLATERAL_WEBHOOK` / `DISBURSEMENT_WEBHOOK`
- Verify webhook signatures on parsed JSON — always raw body
- Return stack traces or internal error detail to clients
- Use offset pagination
- Log BVN, NIN, account numbers, session tokens, Lightning secrets, BOLT11 strings
