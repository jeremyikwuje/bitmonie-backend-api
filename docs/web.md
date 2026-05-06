# Web client integration spec

Detail doc — read when extending the API for `bitmonie-web` (the customer-facing SvelteKit app at `web.bitmonie.co`), or when building a screen that needs an endpoint that doesn't yet exist.

This spec is the contract between this API and the web client. The web codebase lives at `~/source/apps/bitmonie-web/` (sibling repo) and consumes only the `/v1/...` routes documented here.

> **This file is mirrored to `bitmonie-web/docs/web.md`** so the frontend team can read the contract without checking out this repo. **The two copies must stay in sync** — any PR that changes the API contract here must also update the frontend copy in the same change. The frontend mirror has a matching notice at the top.

---

## 1. Audience + scope

- Built for: a single web client at `web.bitmonie.co` — mobile-first, 2-tab shell (Home / Loans), avatar sheet, no admin/ops surface.
- **Out of scope here:** anything under `/v1/ops/*` or `/v1/webhooks/*`. The web client never touches those.
- This doc is subordinate to CLAUDE.md and tdd.md. If a screen-level requirement implies an API change, that change still has to satisfy §5 platform rules. Authority order on conflict: CLAUDE.md > tdd.md > web.md.

---

## 2. Auth + transport

- Browser → `https://api.bitmonie.co/v1/...` from origin `https://web.bitmonie.co`.
- The session cookie set by `POST /v1/auth/login` is `HttpOnly`, `Secure`, `SameSite=None` in non-dev environments so it works for cross-site SPA auth (e.g. `localhost:5173 → api.bitmonie.co` or `web.bitmonie.co → api.bitmonie.co`). In `NODE_ENV=development` it falls back to `SameSite=Lax` + `Secure=false` so localhost-to-localhost dev works without HTTPS. CSRF is mitigated by `HttpOnly` + the `ALLOWED_ORIGIN` allowlist (preflight gates which origins can even attempt credentialed requests) + the `Idempotency-Key` requirement on every write.
- **CORS:** `Access-Control-Allow-Origin: https://web.bitmonie.co` + `Access-Control-Allow-Credentials: true`. The `ALLOWED_ORIGIN` env var must include the production web origin and any preview origins.
- The web client always sends `credentials: 'include'`. There is no `Authorization` header path for the web client — session cookie only.
- Any 401 on an authed call → web client clears in-memory user state and routes to `/login`. Never auto-refresh, never silently retry.

---

## 3. Onboarding gates

The web client enforces a linear gate before mounting the app shell. Three of the four checks come from a single `GET /v1/users/me` call (which returns `email_verified`, `kyc_tier`, and the nested `repayment_account` block in one shot — see §4 for the full shape). The fourth needs a separate count.

| Gate | Source | Failed → route to |
|---|---|---|
| Authenticated | `GET /v1/users/me` 200 (vs. 401) | `/login` |
| Email verified | `users/me` → `email_verified === true` | `/verify-email` |
| KYC tier-1 | `users/me` → `kyc_tier >= 1` | `/kyc` |
| Has ≥ 1 disbursement account | `GET /v1/disbursement-accounts` → `accounts.length > 0` | `/add-bank` |

Once all four pass, the web client mounts `/`, `/loans`, etc. The `KycTierGuard` + `RequiresKyc(1)` on `POST /v1/loans/checkout` is still the authoritative server-side enforcement — the gate is convenience, not security.

> Note: `GET /v1/auth/me` also exists and returns a *minimal* identity payload (`id, email, email_verified, totp_enabled, created_at`) but **not** `kyc_tier` or `repayment_account`. Use `users/me` for the gate; `auth/me` is unnecessary for the web client.

---

## 4. Screen → endpoint map

| Screen | Endpoints |
|---|---|
| `/signup` | `POST /v1/auth/signup` |
| `/verify-email` | `POST /v1/auth/verify-email`, `POST /v1/auth/resend-verification` |
| `/login` | `POST /v1/auth/login` (incl. 2FA submit) |
| `/forgot-password`, `/reset-password` | `POST /v1/auth/forgot-password`, `POST /v1/auth/reset-password` |
| `/kyc` | `POST /v1/kyc/tier-1`, `GET /v1/kyc/status` |
| `/add-bank` + avatar-sheet bank management | `GET /v1/banks`, `POST /v1/disbursement-accounts`, `GET /v1/disbursement-accounts`, `PATCH /v1/disbursement-accounts/:id/default`, `DELETE /v1/disbursement-accounts/:id` |
| **Top bar "You Owe" + Home attention banners** | **NEW** `GET /v1/me/summary` (§5.1) |
| Home — calculator | `GET /v1/loans/calculate` (debounced on input) |
| Home — checkout | `POST /v1/loans/checkout` (Idempotency-Key required) |
| **Home — activity feed** | **NEW** `GET /v1/activity` (§5.2) |
| Loans — list | `GET /v1/loans` |
| Loans — inflows banner | `GET /v1/inflows/unmatched` (count + total — `me/summary` already carries this; full list only on tap-through) |
| `/inflows` | `GET /v1/inflows/unmatched`, `POST /v1/inflows/:inflow_id/apply` (Idempotency-Key) |
| Loan detail (PENDING_COLLATERAL) | `GET /v1/loans/:id`, `POST /v1/loans/:id/cancel` |
| Loan detail (ACTIVE) | `GET /v1/loans/:id`, `GET /v1/loans/:id/repayment-instructions`, `POST /v1/loans/:id/add-collateral` (Idempotency-Key) |
| Loan detail — set/change release address | `POST /v1/loans/:id/release-address/request-change-otp`, `PATCH /v1/loans/:id/release-address` |
| Avatar sheet — Profile / Security | `GET /v1/users/me`, `GET /v1/auth/2fa/setup`, `POST /v1/auth/2fa/confirm`, `POST /v1/auth/2fa/disable`, `POST /v1/auth/logout`, `POST /v1/auth/logout-all` |
| Avatar sheet — Repayment account | `GET /v1/users/me` → `repayment_account: { virtual_account_no, virtual_account_name, bank_name, provider } \| null` (already nested in profile response — no extra call) |
| Avatar sheet — Rates | `GET /v1/rates` — public, no auth. Returns `{ rates: [{ pair, rate_buy, rate_sell, fetched_at }] }` for SAT_NGN / BTC_NGN / USDT_NGN. Returns 422 if the feed is stale. |

The web client does not call any deprecated endpoint. `POST /v1/loans/:id/claim-inflow` is replaced end-to-end by `GET /v1/inflows/unmatched` + `POST /v1/inflows/:id/apply`.

---

## 5. NEW endpoints (build before web client lands)

Both endpoints are read-only, per-user, no idempotency needed. Both inherit `SessionGuard`. Recommend a new feature module `me/` to host them — the existing `users/me` is unrelated (raw user row).

### 5.1 `GET /v1/me/summary`

Single-shot snapshot the web client polls on app focus and after every write that could move balance / attention state. Exists so the top bar's "You Owe" and Home's attention-banner peek-stack don't require fetching every loan client-side.

**Response 200:**

```json
{
  "outstanding_ngn": "525000",
  "daily_accrual_ngn": "2200",
  "active_loan_count": 2,
  "attention": [
    {
      "loan_id": "uuid",
      "kind": "PENDING_COLLATERAL",
      "urgency": 100,
      "title": "Send 1,500,000 SAT",
      "subtitle": "Pay before 14:32 to start your ₦500,000 loan",
      "expires_at": "2026-05-05T14:32:00Z"
    },
    {
      "loan_id": "uuid",
      "kind": "OVERDUE_GRACE",
      "urgency": 80,
      "title": "Loan ₦500,000 is overdue",
      "subtitle": "Day 3 of 7-day grace — repay or top up collateral",
      "expires_at": "2026-05-12T00:00:00Z"
    }
  ],
  "unmatched_inflow_count": 1,
  "unmatched_inflow_total_ngn": "10000"
}
```

Fields:

- `outstanding_ngn` — sum of `AccrualService.compute(loan, repayments, now)` across all `ACTIVE` loans, displayed via `displayNgn(..., 'ceil')` to match repayment-side rounding (customer pays us → ceil).
- `daily_accrual_ngn` — total amount the user's outstanding will grow by tomorrow if they take no action: interest + custody, summed across every `ACTIVE` loan. Interest is computed against the current outstanding principal (post-repayments), so partial repayments lower it. Custody is fixed at origination and accrues regardless of repayments. Drives the "₦X accrues daily" urgency line on Home. `"0"` when no `ACTIVE` loans.
- `active_loan_count` — count of loans in `ACTIVE`. `PENDING_COLLATERAL` excluded — it has zero outstanding.
- `attention[]` — loans needing user action, sorted by `urgency` desc. Web renders this as the peek-stack on Home (top card visible, others peek with a `+N more` indicator). Empty array when nothing needs attention.
  - `kind` enum: `PENDING_COLLATERAL`, `OVERDUE_GRACE`, `LIQUIDATION_RISK` (`collateral_ngn < ALERT_THRESHOLD × outstanding`, i.e. 1.20×), `AWAITING_RELEASE_ADDRESS` (REPAID with NULL `collateral_release_address`).
  - `urgency` is a stable integer the server computes; web sorts on it. Don't promise a particular range — just sort desc.
  - `title` / `subtitle` are display-ready strings. Server owns the copy so it stays consistent with email/reminder tone.
  - `expires_at` — soonest deadline relevant to that card (invoice expiry, grace expiry). Optional.
- `unmatched_inflow_count` / `unmatched_inflow_total_ngn` — drives the Loans-tab inflows banner without forcing the client to call `/v1/inflows/unmatched` until the user taps in. `total_ngn` is `displayNgn(..., 'ceil')`.

**Caching:** none. Computed live. Cheap because it scans only the user's own ACTIVE loans + a single COUNT on unmatched inflows.

**Errors:** 401 if session invalid. No other failure modes worth surfacing — empty result is the "no loans" state, not an error.

### 5.2 `GET /v1/activity`

Cursor-paginated stream of money-movement events for the authenticated user. **Money-only** — auth events (login, password change, 2FA toggle) are deliberately excluded. Those live under Security in the avatar sheet, queried separately on demand.

**Query:**

- `cursor` — opaque string (last item's composite cursor). Omit for first page.
- `limit` — default 20, max 50.

**Response 200:**

```json
{
  "items": [
    {
      "id": "evt_<base64>",
      "occurred_at": "2026-05-05T13:14:15Z",
      "type": "LOAN_DISBURSED",
      "title": "₦500,000 sent to GTB ****1234",
      "subtitle": "Loan #abc1234",
      "amount_ngn": "500000",
      "loan_id": "uuid",
      "link": "/loans/uuid"
    },
    {
      "id": "evt_<base64>",
      "occurred_at": "2026-05-05T13:10:02Z",
      "type": "COLLATERAL_RECEIVED",
      "title": "1,500,000 SAT collateral received",
      "subtitle": "Loan #abc1234",
      "amount_sat": "1500000",
      "loan_id": "uuid",
      "link": "/loans/uuid"
    }
  ],
  "next_cursor": "..."
}
```

`next_cursor` is `null` when there are no more pages.

**`type` enum (initial set):**

- `LOAN_CREATED` — checkout completed, awaiting collateral.
- `COLLATERAL_RECEIVED` — initial collateral confirmed, loan now ACTIVE.
- `COLLATERAL_TOPPED_UP` — add-collateral inflow matched.
- `LOAN_DISBURSED` — disbursement SUCCESSFUL.
- `REPAYMENT_RECEIVED` — NGN inflow credited (partial or full; `LOAN_REPAID` is emitted alongside if it closed the loan).
- `LOAN_REPAID` — final repayment closed the loan.
- `COLLATERAL_RELEASED` — SAT sent back to the customer.
- `LOAN_LIQUIDATED` — collateral seized.
- `LOAN_EXPIRED` — pending invoice expired before payment.
- `LOAN_CANCELLED` — customer cancelled before sending SAT.
- `INFLOW_RECEIVED_UNMATCHED` — payment received but not auto-matched (links to `/inflows`).

**Source rows (server-side union):**

- `loan_status_logs` is the single source of truth for everything that has a `reason_code` — `LoanReasonCodes` already disambiguates each `type` above.
- `inflows` is the source for `INFLOW_RECEIVED_UNMATCHED` only (matched inflows surface via the `loan_status_logs` row that records the credit).
- `outflows` is **not** queried directly. `LOAN_DISBURSED` and `COLLATERAL_RELEASED` come from their `loan_status_logs` rows. This avoids the dedupe burden of unioning two timestamp streams.

Picking one source per `type` is a hard rule. If two sources can produce the same `type`, the spec is wrong — fix the spec, not the query.

**Cursor format:** `base64(occurred_at_iso || ':' || stable_id)`. Sort `occurred_at DESC, id DESC`. Page boundary uses `(occurred_at, id) < cursor` so insertions during paging don't shift the window.

**Caching:** none. Read straight from the source tables. The first page is small and warm enough for direct DB reads.

**Errors:** 401 if session invalid. 400 on malformed cursor.

---

## 6. Web client conventions (for cross-team awareness)

These are duplicated in the web repo's `CLAUDE.md`; restated here so backend devs reviewing PRs that touch the contract know what's expected on the other side:

- **Idempotency-Key:** generated per write action via `crypto.randomUUID()`. Stored on the in-flight mutation; on retry (same action), reused. Background TanStack Query retries reuse the same key by construction.
- **Money rendering:** API returns NGN as decimal strings already rounded for display (ceil for receivables, floor for payables — see `displayNgn`). Web renders them as-is. The web client never does Decimal arithmetic. If a screen needs a sum of two amounts, the API exposes the sum; we do not compute client-side.
- **Errors:** every error matches §5.10 of root CLAUDE.md. Web's `apiClient` extracts `error.code` and `error.message` and surfaces `message` directly to the user (server owns copy). 401 is handled centrally; everything else surfaces inline on the relevant form/screen.
- **Polling cadence:** `GET /v1/me/summary` on app focus + after every write that resolves successfully. No background polling. Loan detail screens poll `GET /v1/loans/:id` every 10 s while in `PENDING_COLLATERAL` (waiting for collateral webhook), otherwise on focus only.
- **No service workers, no offline mode** in v1.

---

## 7. What the web client deliberately doesn't surface

- Disbursement retry / cancel — ops only.
- Outflow attempt history — ops only.
- Webhook log — ops only.
- Auth session list / device list — out of scope for v1. "Logout everywhere" exists via `POST /v1/auth/logout-all` from the avatar sheet.
- Per-loan reminder schedule — the customer just receives the emails; they don't need to inspect the schedule.

---

## 8. Resolved questions (audit trail)

These were open in the first cut of this spec; resolved against the codebase on 2026-05-05. Kept here so future readers see what was checked and where.

| Question | Answer | Where it lives |
|---|---|---|
| Rates endpoint path + shape | `GET /v1/rates` (public). Response: `{ rates: [{ pair: AssetPair, rate_buy: string, rate_sell: string, fetched_at: ISO8601 }] }`. 422 if stale. | `src/modules/price-feed/price-feed.controller.ts`, `dto/rate-item.dto.ts` |
| Where the permanent NGN VA is exposed | `GET /v1/users/me` → `repayment_account: { virtual_account_no, virtual_account_name, bank_name, provider } \| null`. The `user-repayment-accounts` module has a service but **no controller** — there is no separate endpoint to call. | `src/modules/users/users.service.ts` |
| `auth/me` vs `users/me` | `auth/me` returns a minimal identity payload (`id, email, email_verified, totp_enabled, created_at`); `users/me` returns the full profile including names, `kyc_tier`, `disbursement_enabled`, `loan_enabled`, and `repayment_account`. Web uses `users/me` for the onboarding gate and the Profile/Repayment cards; `auth/me` is unused. | `src/modules/auth/auth.controller.ts:194`, `src/modules/users/users.service.ts` |
| `GET /v1/loans/calculate` reachable unauthenticated | Yes. No method-level guard, no class-level guard on `LoansController`, no global guard registered in `main.ts` / `app.module.ts`. Safe to call from marketing or pre-signup flows. | `src/modules/loans/loans.controller.ts:63` |

## 9. Still open

None — all known questions resolved. Add new ones above as they surface during web-client build.

---

## Appendix A — `POST /v1/disbursement-accounts` response shape

```json
{
  "id": "uuid",
  "account_holder_name": "ADA OBI",
  "name_match_score": 0.97,
  "status": "VERIFIED",
  "is_default": true,
  "message": "Disbursement account added successfully."
}
```

- `account_holder_name` — the name returned by the rail (PalmPay name lookup), confirmed to match the user's KYC name above the `DISBURSEMENT_NAME_MATCH_THRESHOLD` (0.85). `null` for `CRYPTO_ADDRESS` (no name match performed).
- `name_match_score` — `0.0` to `1.0`. `null` for `CRYPTO_ADDRESS`.
- `status` — `DisbursementAccountStatus` enum. Always `VERIFIED` on a successful add (failed name match throws 422 instead of returning a `PENDING` row).
- `is_default` — `true` when this is the first account for the given kind (auto-defaulted), `false` otherwise.

The web's add-bank screen renders a confirmation card from this response: "We matched **ADA OBI** against your account — looks good." No follow-up `GET /v1/disbursement-accounts` needed.
