# Loan Applications — Public Intake Endpoint

Status: **spec, implementation pending**. Sibling to the deferred `get-quote` module from CLAUDE.md §2.

> On lock, this doc owns the contract for `POST /v1/loan-applications`. Error catalog entries (`docs/errors.md`), CLAUDE.md §2 scope, and the new Prisma model are updated alongside implementation, not in this doc.

---

## 0. Why this exists

The Bitmonie landing page (`bitmonie.com/apply`) collects two persona groups that don't fit the self-service Bitcoin-collateral flow:

- **Non-BTC asset owners** who want OTC handling against physical collateral (cars, MacBooks, iPhones).
- **BTC owners** who prefer human-assisted onboarding rather than self-service Lightning checkout.

For both groups the loans team handles intake by hand. This endpoint is the intake pipe.

No amount-based floor: an applicant at any loan size can use this endpoint if they want human handling — self-serve is the fast path, not the only path. The cap (§1 row 3) is a sanity check, not a business gate.

This may supersede the deferred `get-quote` module mentioned in CLAUDE.md §2; see §9.

---

## 1. Locked decisions

| # | Decision |
|---|---|
| 1 | Endpoint is `POST /v1/loan-applications` (plural, matches `/v1/loans`, `/v1/inflows`, `/v1/disbursement-accounts`). Module name `loan-applications` under `src/modules/`. |
| 2 | Public, unauthenticated. No `SessionGuard`. Rate-limited via `@nestjs/throttler` (same pattern as auth endpoints). |
| 3 | Loan-amount cap is `₦100,000,000`. No floor — applicants below the self-serve line (`MAX_SELFSERVE_LOAN_NGN = ₦10M`) can still use this endpoint if they prefer human handling. The cap is a sanity check, not a business gate. |
| 4 | Error responses use the standard `{ error: { code, message, details, request_id } }` shape produced by `GlobalExceptionFilter`. No `ok` envelope. |
| 5 | `loan_amount_ngn` stored as `Decimal @db.Decimal(20, 2)` — matches `Loan.principal_ngn` and every other NGN column in the schema. Never BIGINT, never kobo. |
| 6 | `status` is a Prisma enum `LoanApplicationStatus` with SCREAMING_SNAKE_CASE members. `collateral_type` is a Prisma enum `LoanApplicationCollateralType`. |
| 7 | Email stored as `VarChar(160)`, lowercased in app code on ingress. No CITEXT (project convention). |
| 8 | Ops notification routes through `OpsAlertsService.alertNewLoanApplication(...)`. Recipient is `app.loan_applications_email` if set, else falls back to `app.internal_alert_email`. The address `loans@bitmonie.co` is a config value, not source. |
| 9 | Bot traps (`website` honeypot + `rendered_at` fill-time gate) silently accept-and-drop. Drops emit a structured log event (`loan_application_dropped` with `reason`), persist nothing, and do **not** increment the per-IP throttle counter. |
| 10 | Cloudflare Turnstile is Phase 2, gated by `TURNSTILE_SECRET_KEY` env var. When the var is unset the field is ignored; when set, verification is **fail-closed** (siteverify outage rejects with 429). |
| 11 | Validation errors aggregate (one 400 with every offending field), via the existing global `ValidationPipe`. |

---

## 2. Endpoint contract

### 2.1 Request

```
POST /v1/loan-applications
Content-Type: application/json
X-Forwarded-For: <visitor IP, forwarded by the landing-page proxy>
User-Agent: <browser UA>
```

**Body — applicant fields (all required):**

| Field                    | Type   | Constraint                                                                                       |
| ------------------------ | ------ | ------------------------------------------------------------------------------------------------ |
| `first_name`             | string | 1–80 chars, trimmed                                                                              |
| `last_name`              | string | 1–80 chars, trimmed                                                                              |
| `email`                  | string | Valid email per `@IsEmail()`, ≤160 chars, lowercased before storage                              |
| `phone`                  | string | ≤40 chars; must contain ≥7 digits after stripping non-digits                                     |
| `collateral_type`        | enum   | One of the values in §2.3                                                                        |
| `collateral_description` | string | 1–1000 chars, trimmed                                                                            |
| `loan_amount_ngn`        | number | Integer naira, `> 0` and `≤ 100_000_000`. Accepted as `number` in the DTO, stored as `Decimal`.  |

**Body — bot-trap fields (optional; see §6):**

| Field           | Type   | Constraint                                                                                                          |
| --------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| `website`       | string | Honeypot. `@IsOptional() @IsString() @MaxLength(200)`. Non-empty after trim ⇒ silent drop.                          |
| `rendered_at`   | number | Unix-ms timestamp captured client-side when the form mounted. `@IsOptional() @IsInt()`. Gate logic in §6.2.         |
| `turnstile_token` | string | Phase 2 only. Required iff `TURNSTILE_SECRET_KEY` is set. Verified against Cloudflare siteverify.                 |

The landing-page proxy already validates these fields, but this endpoint **must validate independently** — the proxy is one of many possible callers and can be bypassed.

### 2.2 Success response

```
201 Created
Content-Type: application/json
```

```json
{ "application_id": "<uuid>" }
```

The id is the application's UUID primary key. The landing page does not use it; it's returned for support and log-correlation.

**Silent-drop responses** (honeypot, fill-time gate, Phase-2 Turnstile soft reject): `201 Created` with **empty body**. Bots can't tell the submission was dropped.

### 2.3 `collateral_type` enum

Exact strings, shared with the landing page. Update both repositories together when this changes.

```
Bitcoin (BTC)
USDT / USDC
MacBook (M1 or newer)
iPhone (13 or newer)
Car (2008 or newer)
```

Internally these are mapped to a Prisma enum `LoanApplicationCollateralType` with SCREAMING_SNAKE_CASE members:

```
BITCOIN
USDT_USDC
MACBOOK_M1_OR_NEWER
IPHONE_13_OR_NEWER
CAR_2008_OR_NEWER
```

The display strings live in a single mapping function next to the controller; the DTO accepts the display strings and translates to the enum at the service boundary. Any other value → `VALIDATION_FAILED` with `field: 'collateral_type'`.

### 2.4 Error responses

Every error uses the standard shape produced by `GlobalExceptionFilter` ([global-exception.filter.ts](../src/common/filters/global-exception.filter.ts)). No `ok` envelope, no custom shapes.

**400 — validation failure** (one response per request, aggregating every offending field):

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request body failed validation.",
    "details": [
      { "field": "email", "issue": "Valid email is required" },
      { "field": "loan_amount_ngn", "issue": "Loan amount cannot exceed ₦10,000,000" }
    ],
    "request_id": "req_..."
  }
}
```

**400 — malformed JSON:**

```json
{
  "error": {
    "code": "INVALID_JSON",
    "message": "Request body is not valid JSON.",
    "request_id": "req_..."
  }
}
```

**429 — rate limited** (with `Retry-After` header):

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests, please try again later.",
    "request_id": "req_..."
  }
}
```

**500 — internal error:**

Standard shape from `GlobalExceptionFilter`. Stack traces never leak.

---

## 3. Validation rules

Implement these server-side. Each rule maps to one acceptance test in §8.

| ID  | Field                    | Rule                                                              | Issue message                                          |
| --- | ------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------ |
| V01 | `first_name`             | Required, non-empty after trim                                    | `First name is required`                               |
| V02 | `first_name`             | ≤80 chars                                                         | `First name is too long`                               |
| V03 | `last_name`              | Required, non-empty after trim                                    | `Last name is required`                                |
| V04 | `last_name`              | ≤80 chars                                                         | `Last name is too long`                                |
| V05 | `email`                  | `@IsEmail()` (class-validator default), ≤160 chars                | `Valid email is required`                              |
| V06 | `phone`                  | ≥7 digits after stripping non-digits, ≤40 chars raw               | `Valid phone is required`                              |
| V07 | `collateral_type`        | One of the §2.3 display strings                                   | `Select a collateral type`                             |
| V08 | `collateral_description` | Required, 1–1000 chars after trim                                 | `Describe your collateral`                             |
| V09 | `loan_amount_ngn`        | Finite number, `> 0`                                              | `Enter a loan amount`                                  |
| V10 | `loan_amount_ngn`        | `≤ 100_000_000`                                                   | `Loan amount cannot exceed ₦100,000,000`               |

All string fields trimmed before validation and storage. Email lowercased on ingress.

---

## 4. Persistence

### 4.1 Prisma model

```prisma
enum LoanApplicationStatus {
  NEW
  CONTACTED
  APPROVED
  REJECTED
  CLOSED
}

enum LoanApplicationCollateralType {
  BITCOIN
  USDT_USDC
  MACBOOK_M1_OR_NEWER
  IPHONE_13_OR_NEWER
  CAR_2008_OR_NEWER
}

model LoanApplication {
  id                     String                       @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  created_at             DateTime                     @default(now()) @db.Timestamptz(6)
  updated_at             DateTime                     @updatedAt @db.Timestamptz(6)

  first_name             String                       @db.VarChar(80)
  last_name              String                       @db.VarChar(80)
  email                  String                       @db.VarChar(160)
  phone                  String                       @db.VarChar(40)

  collateral_type        LoanApplicationCollateralType
  collateral_description String                       @db.VarChar(1000)
  loan_amount_ngn        Decimal                      @db.Decimal(20, 2)

  status                 LoanApplicationStatus        @default(NEW)
  assigned_to_ops_user_id String?                     @db.Uuid
  assigned_to            OpsUser?                     @relation(fields: [assigned_to_ops_user_id], references: [id])
  notes                  String?

  client_ip              String?                      @db.VarChar(45)
  user_agent             String?                      @db.VarChar(512)

  @@index([email])
  @@index([created_at(sort: Desc)])
  @@index([status])
  @@map("loan_applications")
}
```

Migration also adds a CHECK constraint (raw SQL — Prisma doesn't model it):

```sql
ALTER TABLE loan_applications
  ADD CONSTRAINT chk_loan_amount_ngn
  CHECK (loan_amount_ngn > 0 AND loan_amount_ngn <= 100000000);
```

### 4.2 Amount storage

`Decimal(20, 2)`. Matches `Loan.principal_ngn` and every other NGN column. Service layer converts the DTO's `number` to `new Decimal(...)` at the boundary — same pattern as `CheckoutLoanDto` / `CalculateLoanDto`.

### 4.3 Audit capture

- `client_ip` ← first hop of `X-Forwarded-For`, falling back to the connection remote address.
- `user_agent` ← `User-Agent` header, truncated to 512 chars.

`X-Forwarded-For` parsing requires `app.set('trust proxy', ...)` to be configured on the Express adapter. If it isn't already, set it in `main.ts` to match the deployment topology (1 hop behind Railway's edge proxy, or whatever the prod topology is — verify before launch).

---

## 5. Ops notification

After successful persistence, dispatch via:

```ts
OpsAlertsService.alertNewLoanApplication({
  application_id,
  first_name,
  last_name,
  email,        // applicant email → used as Reply-To
  phone,
  collateral_type_display,  // human-readable string from §2.3
  collateral_description,
  loan_amount_ngn,
  created_at,
});
```

Behaviour:

- **Recipient:** `ConfigService.get<AppConfig>('app').loan_applications_email ?? internal_alert_email`. Add the new key to [app.config.ts](../src/common/config/app.config.ts) and `.env.example` (`LOAN_APPLICATIONS_EMAIL`).
- **From:** existing transactional sender (`noreply@bitmonie.co` per `EmailProvider` default).
- **Reply-To:** the applicant's email, so ops can hit reply. Requires `TransactionalEmailParams.reply_to?: string` on [email.provider.interface.ts](../src/modules/auth/email.provider.interface.ts) — if not present, extend the interface and pass through in each concrete provider (`mailgun`, `postmark`, `resend`).
- **Subject:** `New loan application — {first_name} {last_name} (₦{loan_amount_ngn})`.
- **Body:** plain text (no HTML), template inline in `OpsAlertsService`. Matches the format in §5 of the v2 doc:

```
New loan application received.

Name:        {first_name} {last_name}
Email:       {email}
Phone:       {phone}

Loan amount: ₦{loan_amount_ngn formatted with thousands separators}
Collateral:  {collateral_type_display}

Description:
{collateral_description}

Submitted:   {created_at, Africa/Lagos timezone}
Application: {dashboard_url}/loan-applications/{application_id}
```

- **Delivery semantics:** fire-and-forget, matching every other `OpsAlertsService` method. Wrap the send in try/catch; on failure, log `{ event: 'loan_application_email_failed', application_id, error }` at error level and do **not** fail the request. Persistence is the source of truth.

---

## 6. Security & abuse mitigation

This endpoint is public. The mitigations below are required, not optional. Cheapest-first: silent traps catch crude bots (§6.1, §6.2), rate limits stop a determined caller (§6.3), Turnstile (§6.4) is the upgrade path when traffic patterns demand it.

### 6.1 Honeypot — `website`

The landing-page form ships `website` as a visually hidden, off-screen input with `tabindex="-1"` and `aria-hidden="true"`. Real users never fill it; automated form-fillers populate every visible (to them) input.

Trip condition: `typeof website === 'string' && website.trim().length > 0`.

On trip:
- Return `201 Created` with **empty body**.
- Emit structured log: `{ event: 'loan_application_dropped', reason: 'honeypot', client_ip, user_agent }`.
- Persist nothing, send no email.
- Do **not** increment the per-IP rate-limit counter (see §6.3 implementation note).

### 6.2 Fill-time gate — `rendered_at`

Client-side unix-ms timestamp captured when the form mounted. Three checks:

1. **Type:** `Number.isInteger(rendered_at)`. Otherwise → ignore the gate.
2. **Max age:** `server_now - rendered_at ≤ 86_400_000` (24h). Older than 24h → ignore the gate (prevents bots replaying a stale timestamp from yesterday).
3. **Future:** `server_now - rendered_at ≥ 0`. Client clock ahead of server → ignore the gate (the spec is lenient on clock skew).
4. **Floor:** `server_now - rendered_at < 1500` → **trip the gate** (submitted in under 1.5 seconds).

On trip: same silent-drop behaviour as §6.1, with `reason: 'fill_time'`.

If `rendered_at` is missing entirely, the gate is skipped — never punish callers for omitting an optional defence.

The check is spoofable (a bot can fake the timestamp), so it stacks with the honeypot and rate limit rather than standing alone.

### 6.3 Rate limiting

- **Per-IP:** 5 successful submissions per IP per hour. Use `@nestjs/throttler` with `@Throttle({ default: { ttl: 3_600_000, limit: 5 } })`. Reject with `429` + `Retry-After: 3600`.
- **Tracker:** `req.ip`, which Express derives from `X-Forwarded-For` only when `trust proxy` is configured. Verify the setting in `main.ts` reflects the production hop count.
- **Global:** 100 submissions per minute system-wide. Out of scope for `@nestjs/throttler` (only does per-tracker); implement as a Redis counter in the service if v1 launch traffic warrants it. **Phase 2 — do not block v1 ship on this.** When tripped, return `429` to all callers and emit an `OpsAlertsService` page.
- **Bot-trap drops must not increment the throttler counter.** Implementation note: NestJS guards run in registration order. Register a small `LoanApplicationsBotTrapGuard` **before** the `ThrottlerGuard` on this route. The bot-trap guard inspects `req.body` (already parsed by NestJS's body parser middleware), and when it detects a trip it (a) sets `req._loan_application_dropped = { reason }`, (b) short-circuits via a thrown `LoanApplicationSilentlyDroppedException` that the controller-level interceptor catches and converts to `201` with empty body, and (c) emits the structured log. A custom `ThrottlerGuard` subclass checks `req._loan_application_dropped` in `shouldSkip` and skips counting when set. Without this, a single bot on a shared NAT (office, CGNAT) can lock everyone out for an hour just by spamming the trap.

### 6.4 Cloudflare Turnstile (Phase 2)

When `TURNSTILE_SECRET_KEY` is **unset** (default), the field is ignored entirely — Turnstile is a flip-the-switch defence, not a coupled hard dependency.

When `TURNSTILE_SECRET_KEY` is set:

1. The landing page mounts the Turnstile widget below the form CTA; the resulting token is sent as `turnstile_token` in the request body.
2. The endpoint POSTs `{ secret: $TURNSTILE_SECRET_KEY, response: turnstile_token, remoteip: client_ip }` to `https://challenges.cloudflare.com/turnstile/v0/siteverify`.
3. On `success: true` → proceed.
4. On `success: false` → reject with `400 { code: 'TURNSTILE_VERIFICATION_FAILED' }`, log structured event.
5. On siteverify network error / timeout → **fail-closed**. Reject with `429 { code: 'TURNSTILE_VERIFICATION_UNAVAILABLE' }`, page ops via `OpsAlertsService.alertTurnstileOutage(...)` with 1h dedupe. Rationale: this is a low-volume enquiry form; a brief outage costing a handful of legitimate submissions is acceptable; a brief spam wave during an outage is not.

Document `TURNSTILE_SECRET_KEY` in `.env.example` with an "unset by default" comment.

### 6.5 CORS

Server-to-server from the landing-page SSR layer — browser CORS not required for the normal flow. If browsers ever call this endpoint directly (not currently planned), restrict to `https://bitmonie.com` and `https://www.bitmonie.com`. Otherwise leave the existing `app.enableCors(...)` config alone.

### 6.6 No PII in logs

Log only `application_id`, status code, timing, and (for drops) `reason` + `client_ip` + truncated `user_agent`. Never log `email`, `phone`, or `collateral_description`. If structured-log enrichment captures the raw body, scrub these fields via the existing pino redaction config in [logger.config.ts](../src/common/config/logger.config.ts) (verify the keys are listed there — extend if not).

---

## 7. Dashboard integration

Out of scope for this endpoint. Schema in §4.1 supports:

- List view: order by `created_at DESC`, filter by `status`, click-through to a detail view.
- Status transitions: `NEW → CONTACTED → APPROVED | REJECTED → CLOSED`. Track the transition in a separate `application_events` audit table (separate ticket — recommended but not required for v1).
- Unread badge: count of `status = NEW` rows.

---

## 8. Acceptance tests

Write these before implementation. The endpoint is correct iff every test below passes.

### 8.1 Happy path

```
GIVEN a valid payload (all fields populated, loan amount ₦5,000,000, collateral "Bitcoin (BTC)")
WHEN  POST /v1/loan-applications
THEN  status 201
AND   response body is { application_id: <uuid> }
AND   a row exists in loan_applications with status=NEW and matching fields
AND   the stored loan_amount_ngn is Decimal "5000000.00"
AND   the stored collateral_type is BITCOIN
AND   an email was dispatched to the resolved ops recipient with applicant name in subject
AND   the email Reply-To header equals the applicant's email
```

### 8.2 Validation — missing required field

```
GIVEN a payload with empty first_name
WHEN  POST /v1/loan-applications
THEN  status 400
AND   response body is { error: { code: "VALIDATION_FAILED", message: ..., details: [{ field: "first_name", issue: "First name is required" }], request_id: ... } }
AND   no row is created
AND   no email is sent
```

### 8.3 Validation — aggregate errors

```
GIVEN a payload with invalid email AND loan_amount_ngn = 0 AND missing collateral_description
WHEN  POST /v1/loan-applications
THEN  status 400
AND   response.error.details contains entries for email, loan_amount_ngn, and collateral_description
AND   no row is created
```

### 8.4 Validation — loan cap

```
GIVEN loan_amount_ngn = 100_000_001
WHEN  POST /v1/loan-applications
THEN  status 400
AND   error.details contains { field: "loan_amount_ngn", issue: "Loan amount cannot exceed ₦100,000,000" }
```

### 8.5 Validation — unknown collateral

```
GIVEN collateral_type = "Gold bars"
WHEN  POST /v1/loan-applications
THEN  status 400
AND   error.details contains { field: "collateral_type", issue: "Select a collateral type" }
```

### 8.6 Validation — phone too short

```
GIVEN phone = "123"
WHEN  POST /v1/loan-applications
THEN  status 400
AND   error.details contains { field: "phone", issue: "Valid phone is required" }
```

### 8.7 Email normalisation

```
GIVEN email = "Ada.Lovelace@EXAMPLE.com"
WHEN  POST /v1/loan-applications
THEN  status 201
AND   the stored email == "ada.lovelace@example.com"
```

### 8.8 String trimming

```
GIVEN first_name = "  Ada  "
WHEN  POST /v1/loan-applications
THEN  status 201
AND   the stored first_name == "Ada"
```

### 8.9 Malformed JSON

```
GIVEN body is not valid JSON (e.g. "{")
WHEN  POST /v1/loan-applications
THEN  status 400
AND   response body matches { error: { code: "INVALID_JSON", ... } }
```

### 8.10 Rate limit — per IP

```
GIVEN 5 successful submissions from IP 1.2.3.4 in the last hour
WHEN  the 6th POST /v1/loan-applications from 1.2.3.4 within the hour
THEN  status 429
AND   response body matches { error: { code: "RATE_LIMITED", ... } }
AND   Retry-After header is present and >= 1
AND   no row is created
```

### 8.11 Honeypot trip

```
GIVEN a valid payload with website = "https://spammer.example"
WHEN  POST /v1/loan-applications
THEN  status 201
AND   response body is empty
AND   no row is created
AND   no email is sent
AND   a structured log "loan_application_dropped" with reason="honeypot" is emitted
AND   the per-IP rate-limit counter does NOT increment
```

### 8.11b Fill-time gate trip

```
GIVEN a valid payload with rendered_at = Date.now() (immediate submission)
WHEN  POST /v1/loan-applications
THEN  status 201
AND   response body is empty
AND   no row is created
AND   no email is sent
AND   a structured log "loan_application_dropped" with reason="fill_time" is emitted
```

### 8.11c Fill-time gate — missing field is permitted

```
GIVEN a valid payload with rendered_at omitted
WHEN  POST /v1/loan-applications (≥1500ms after test start)
THEN  status 201
AND   the application is persisted normally
```

### 8.11d Fill-time gate — future timestamp is ignored

```
GIVEN a valid payload with rendered_at = Date.now() + 60_000 (60s in the future, simulating client clock skew)
WHEN  POST /v1/loan-applications
THEN  status 201
AND   the application is persisted normally (gate skipped because diff < 0)
```

### 8.11e Fill-time gate — stale timestamp is ignored

```
GIVEN a valid payload with rendered_at = Date.now() - 86_500_000 (~24h+ ago, simulating a replay)
WHEN  POST /v1/loan-applications
THEN  status 201
AND   the application is persisted normally (gate skipped because diff > 24h)
```

### 8.12 Email failure doesn't block persistence

```
GIVEN the EmailProvider rejects on send
WHEN  POST /v1/loan-applications with a valid payload
THEN  status 201 (still)
AND   the application row exists
AND   an error-level log includes the application_id
```

### 8.13 Field-length limits

```
GIVEN first_name length 81
WHEN  POST /v1/loan-applications
THEN  status 400
AND   error.details contains { field: "first_name", issue: "First name is too long" }
```

### 8.14 Client IP capture

```
GIVEN the request has header X-Forwarded-For: "203.0.113.5, 10.0.0.1"
AND   the Express trust-proxy setting is configured
WHEN  POST /v1/loan-applications with a valid payload
THEN  the stored client_ip == "203.0.113.5" (leftmost hop)
```

---

## 9. Open questions

- **Status workflow.** Does `REJECTED` require a reason field at transition time? Locked default: free-text `notes` only, no enforced reason.
- **Email format.** Plain text confirmed as the safer default (no rendering surprises in Outlook/Gmail apps). Confirm with ops before implementation if there's a preference for an HTML variant.
- **SMS / WhatsApp ping.** Should the loans team also get a WhatsApp / SMS notification on a new application? Out of scope here; flag if desired.
- **Linking to existing accounts.** If the applicant's email matches an existing `User`, attach the application to that user? Defer to v1.1 — adds dashboard complexity without changing the intake flow.

---

## 10. Out of scope

- Frontend implementation (already done in `bitmonie-web`).
- Operator dashboard list/detail views (separate ticket).
- Status-transition audit log table (separate ticket; recommended).
- Auto-decisioning, credit scoring, or KYC integration (handled later in the loan lifecycle, not at application intake).
- Global rate limit (100/min system-wide) — Phase 2.
- Cloudflare Turnstile wiring — Phase 2, env-flagged.

---

## 11. Reference: calling code

The landing-page proxy at `bitmonie-web/src/routes/api/applications/+server.ts`:

1. Validates the same rules described in §3 (defense in depth).
2. Forwards a clean JSON payload to `${API_BASE_URL}/v1/loan-applications`.
3. Forwards the visitor's IP via `X-Forwarded-For`.
4. Maps the API's standard error shape back into the landing page's `{ ok, errors }` browser-facing shape (the proxy is the boundary where envelope shapes can differ).

Until this endpoint exists in production, the proxy short-circuits with `{ ok: true }` (no upstream call) when `API_BASE_URL` is unset. Remove the short-circuit on cutover.

---

## Appendix A. Files this design touches

| Path | Change |
|---|---|
| `prisma/schema.prisma` | Add `LoanApplication` model + `LoanApplicationStatus` + `LoanApplicationCollateralType` enums; add `loan_applications` relation on `OpsUser` |
| `prisma/migrations/<timestamp>_add_loan_applications/migration.sql` | Generated migration + raw CHECK constraint on `loan_amount_ngn` |
| `src/modules/loan-applications/loan-applications.module.ts` | New module |
| `src/modules/loan-applications/loan-applications.controller.ts` | `POST /v1/loan-applications` + guards |
| `src/modules/loan-applications/loan-applications.service.ts` | Validation orchestration, persistence, ops notification dispatch |
| `src/modules/loan-applications/loan-applications.repository.ts` | Prisma I/O |
| `src/modules/loan-applications/dto/create-loan-application.dto.ts` | DTO + class-validator decorators |
| `src/modules/loan-applications/guards/bot-trap.guard.ts` | Honeypot + fill-time gate |
| `src/modules/loan-applications/guards/loan-applications-throttler.guard.ts` | `ThrottlerGuard` subclass that skips on `req._loan_application_dropped` |
| `src/modules/ops-alerts/ops-alerts.service.ts` | Add `alertNewLoanApplication(...)` |
| `src/modules/auth/email.provider.interface.ts` | Add `reply_to?: string` to `TransactionalEmailParams` if missing |
| `src/providers/{mailgun,postmark,resend}/*.provider.ts` | Pass `reply_to` through to the underlying SDK |
| `src/common/config/app.config.ts` | Add `loan_applications_email?: string` + `turnstile_secret_key?: string` |
| `src/common/errors/bitmonie.errors.ts` | Add `LoanApplicationSilentlyDroppedException`, `TurnstileVerificationFailedException`, `TurnstileVerificationUnavailableException` |
| `.env.example` | `LOAN_APPLICATIONS_EMAIL`, `TURNSTILE_SECRET_KEY` (commented out) |
| `docs/errors.md` | Catalog entries for `VALIDATION_FAILED` (if not already present), `INVALID_JSON`, `RATE_LIMITED`, `TURNSTILE_VERIFICATION_FAILED`, `TURNSTILE_VERIFICATION_UNAVAILABLE` |
| `CLAUDE.md` §2 | Add `loan-applications` to the scope table |
| `test/unit/loan-applications/loan-applications.service.spec.ts` | Service unit tests |
| `test/integration/loan-applications/loan-applications.controller.spec.ts` | Controller integration tests covering §8.1–§8.14 |
