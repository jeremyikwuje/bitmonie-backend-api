# Ops Module — Plan

Internal management API for Bitmonie operators. Separate identity domain from customer auth, namespaced at `/v1/ops/*`. First cut covers auth + KYC ops actions only — additional ops endpoints (loans, inflows, disbursements) get added per use case, not scaffolded ahead of demand.

**Authority:** CLAUDE.md > docs/tdd.md > this doc. The "no admin dashboard" deferral in CLAUDE.md §2 refers to a frontend dashboard — this is the API surface that one (and ops engineers using curl) will eventually call against.

---

## 1. Identity model

Separate tables, not a `role` flag on `User`.

**Why separate:** a customer signup can never accidentally inherit ops powers; ops accounts can't take loans; customer DTOs can't leak ops-only fields; a compromised customer session can never escalate. Cost is one parallel auth flow that mirrors the existing customer flow.

### 1.1 New Prisma models

```prisma
model OpsUser {
  id              String        @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  email           String        @unique @db.VarChar(255)
  password_hash   String        @db.VarChar(512)
  totp_secret     String        @db.VarChar(512)              // encrypted; required, not optional
  totp_enabled    Boolean       @default(false)               // false until first successful 2FA enrolment
  full_name       String        @db.VarChar(200)              // for audit log readability
  is_active       Boolean       @default(true)
  last_login_at   DateTime?     @db.Timestamptz
  created_at      DateTime      @default(now()) @db.Timestamptz
  updated_at      DateTime      @updatedAt @db.Timestamptz

  sessions        OpsSession[]
  audit_logs      OpsAuditLog[]

  @@map("ops_users")
}

model OpsSession {
  id            String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  ops_user_id   String    @db.Uuid
  ops_user      OpsUser   @relation(fields: [ops_user_id], references: [id], onDelete: Cascade)
  token_hash    String    @unique @db.VarChar(512)
  expires_at    DateTime  @db.Timestamptz
  ip_address    String?   @db.VarChar(45)
  user_agent    String?   @db.VarChar(512)
  created_at    DateTime  @default(now()) @db.Timestamptz

  @@map("ops_sessions")
}

model OpsAuditLog {
  id            String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  ops_user_id   String    @db.Uuid
  ops_user      OpsUser   @relation(fields: [ops_user_id], references: [id], onDelete: Restrict)
  action        String    @db.VarChar(100)                    // e.g. "kyc.reset", "kyc.provision_va"
  target_type   String    @db.VarChar(50)                     // e.g. "user", "loan"
  target_id     String    @db.VarChar(100)
  details       Json?
  ip_address    String?   @db.VarChar(45)
  request_id    String?   @db.VarChar(100)
  created_at    DateTime  @default(now()) @db.Timestamptz

  @@index([ops_user_id, created_at])
  @@index([target_type, target_id, created_at])
  @@map("ops_audit_logs")
}
```

### 1.2 Audit-log discipline

`OpsAuditLog` is to ops actions what `loan_status_logs` is to loan transitions (CLAUDE.md §5.4): **every state-changing ops action writes a row in the same Prisma transaction as the action itself.** No row, didn't happen. Read-only ops actions don't audit.

Standard `action` values to seed:

```
kyc.reset
kyc.revoke
kyc.provision_va
```

Add new ones in `src/common/constants/ops-actions.ts` before using.

### 1.3 What we are NOT doing (yet)

- Roles / permission scopes — every authenticated `OpsUser` has full ops powers in v1. Add a `role` enum and per-action gating only when there are >1 ops users with materially different jobs.
- Self-service signup, invite flow, password reset via email — operators are provisioned via CLI (§4).
- IP allowlist — leave for ops-side network policy / VPN.
- WebAuthn / hardware keys — TOTP only in v1.

---

## 2. Auth flow

Mirror the customer flow ([auth.service.ts](src/modules/auth/auth.service.ts)) where possible. Differences below.

| Aspect | Customer | Ops |
|---|---|---|
| Cookie name | `session` | `ops_session` |
| Session table | `sessions` | `ops_sessions` |
| Guard | `SessionGuard` | `OpsGuard` |
| 2FA | optional, opt-in | **required from first login** |
| Email verification | required pre-login | not used (no signup endpoint) |
| Password reset | OTP-by-email | CLI re-issue only |
| Throttle on login | 5/min | 5/min |
| Session TTL | `SESSION_TTL_SEC = 86_400` (24h, fixed) | `OPS_SESSION_TTL_SEC = 28_800` (8h, fixed — no sliding) |

### 2.1 Login sequence

`POST /v1/ops/auth/login` is two-step, same shape as customer 2FA today:

1. Body: `{ email, password }`. On valid creds AND `totp_enabled=true`, return `202 { challenge_id }` and DO NOT issue session yet.
2. `POST /v1/ops/auth/verify-2fa` with `{ challenge_id, totp_code }` → issues `OpsSession` + sets `ops_session` cookie.

If `totp_enabled=false` on the OpsUser (first ever login after CLI provisioning), return `403 { code: "OPS_2FA_ENROLMENT_REQUIRED", enrolment_token }` and force enrolment via `POST /v1/ops/auth/enrol-2fa` before any session can be issued.

### 2.2 OpsGuard

Identical to [session.guard.ts](src/common/guards/session.guard.ts):

- Extract token from `ops_session` cookie or `Authorization: Bearer <token>`.
- SHA-256 the token, look up in `ops_sessions`.
- Reject expired or missing.
- Load `OpsUser`, reject `is_active=false`.
- Attach `request.ops_user`.

New decorator `@CurrentOpsUser()` mirroring [current-user.decorator.ts](src/common/decorators/current-user.decorator.ts).

### 2.3 Reused machinery (no fork)

- Argon2id password hashing — `argon2` is already in deps.
- TOTP — `otplib` is already in deps.
- Crypto — reuse `CryptoService` for `totp_secret` AES-256-GCM at rest.
- Session token shape — 32-byte opaque, SHA-256 in DB, HttpOnly Secure cookie.

---

## 3. Endpoint surface (first cut)

All under `/v1/ops/*`. Every endpoint except login is `@UseGuards(OpsGuard)` and `@ApiCookieAuth('ops_session')`.

### 3.1 `ops/auth` module

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/v1/ops/auth/login` | none | Step 1: email + password → `{ challenge_id }` or `OPS_2FA_ENROLMENT_REQUIRED` |
| POST | `/v1/ops/auth/verify-2fa` | none (challenge) | Step 2: TOTP → issues `ops_session` cookie |
| POST | `/v1/ops/auth/enrol-2fa` | enrolment_token | First-time TOTP setup; returns QR + secret |
| POST | `/v1/ops/auth/logout` | OpsGuard | Revokes current `OpsSession` |
| GET | `/v1/ops/auth/me` | OpsGuard | Current ops user profile (email, full_name, last_login_at) |

Throttling: login + verify-2fa + enrol-2fa at `5/min` per IP.

### 3.2 `ops/kyc` module

Lives at `src/modules/ops/kyc/`. Calls into the existing `KycService` and `UserRepaymentAccountsService` — does **not** duplicate logic.

| Method | Path | Purpose | Audit action |
|---|---|---|---|
| GET | `/v1/ops/kyc/:user_id/verifications` | List a user's KYC verifications + raw provider responses | — (read-only) |
| POST | `/v1/ops/kyc/:user_id/provision-va` | Idempotent retry of `UserRepaymentAccountsService.ensureForUser()` — fixes the case where post-KYC VA provisioning failed (the gap noted in [kyc.service.ts:138-145](src/modules/kyc/kyc.service.ts#L138-L145)) | `kyc.provision_va` |
| POST | `/v1/ops/kyc/:user_id/reset` | Reset user to tier 0 (moved from customer KYC controller) | `kyc.reset` |
| POST | `/v1/ops/kyc/:user_id/revoke` | Revoke to specific tier (moved from customer KYC controller) | `kyc.revoke` |

### 3.3 Migration of existing endpoints

`POST /v1/kyc/:user_id/reset` and `POST /v1/kyc/:user_id/revoke` at [kyc.controller.ts:59-81](src/modules/kyc/kyc.controller.ts#L59-L81) currently sit under customer `SessionGuard` only — **any logged-in customer can wipe any user's KYC.** This is a security bug, not just an organisational one.

Plan: move them to `/v1/ops/kyc/...`, **delete the customer-side routes outright** (no compat shim — they aren't depended on by any client we ship). The Postman collection at [test/postman/bitmonie.postman_collection.json](test/postman/bitmonie.postman_collection.json) gets updated in the same PR.

### 3.4 Out of scope for first cut

Listed here so we don't reach for them mid-implementation:

- Loan ops (force-liquidate, manual disbursement retry, force-repaid) — wait until a real ops scenario hits.
- Inflow ops (manual claim, force-match, refund) — same.
- Disbursement / Outflow ops — same.
- Bulk operations (CSV import, batch retry) — never until manual one-offs prove insufficient.
- Read-only "list all loans / inflows / unmatched" dashboards — defer; ops engineers can use SQL replicas in the meantime.

---

## 4. Provisioning ops users

CLI script: `pnpm ops:create-user`.

```
$ pnpm ops:create-user --email=jeremy@bitmonie.com --full-name="Jeremy Ikwuje"
Password (hidden): ***********
Confirm password: ***********
Created OpsUser <uuid>. 2FA will be enrolled on first login.
```

Implementation: a simple Node script under `scripts/create-ops-user.ts` that boots a minimal Nest application context, hashes the password with Argon2id, writes the row. No 2FA provisioning at the CLI — that happens on first browser/curl login via the `enrol-2fa` flow so the secret is generated server-side and never on a developer laptop.

Add a companion `pnpm ops:disable-user --email=...` that flips `is_active=false` and revokes all `OpsSession` rows. No delete — `OpsAuditLog` references must survive.

---

## 5. Module / file layout

```
src/
├── modules/
│   ├── ops/
│   │   ├── auth/
│   │   │   ├── ops-auth.module.ts
│   │   │   ├── ops-auth.controller.ts
│   │   │   ├── ops-auth.service.ts
│   │   │   ├── ops-session.service.ts
│   │   │   ├── ops-audit.service.ts
│   │   │   └── dto/
│   │   │       ├── ops-login.dto.ts
│   │   │       ├── ops-verify-2fa.dto.ts
│   │   │       └── ops-enrol-2fa.dto.ts
│   │   └── kyc/
│   │       ├── ops-kyc.module.ts
│   │       └── ops-kyc.controller.ts    // thin — delegates to KycService + UserRepaymentAccountsService
│
├── common/
│   ├── guards/
│   │   └── ops-session.guard.ts
│   ├── decorators/
│   │   └── current-ops-user.decorator.ts
│   └── constants/
│       └── ops-actions.ts                // OPS_ACTION = { KYC_RESET: 'kyc.reset', ... }
│
└── scripts/
    ├── create-ops-user.ts
    └── disable-ops-user.ts
```

---

## 6. Errors

New `BitmonieException` subclasses (added to [docs/errors.md](docs/errors.md)):

| Code | HTTP | When |
|---|---|---|
| `OPS_INVALID_CREDENTIALS` | 401 | Wrong email or password (deliberately ambiguous — no user enumeration) |
| `OPS_2FA_REQUIRED` | 401 | Login step 1 succeeded; client must call `verify-2fa` |
| `OPS_2FA_ENROLMENT_REQUIRED` | 403 | First-time login; client must call `enrol-2fa` |
| `OPS_2FA_INVALID` | 401 | TOTP code wrong or expired |
| `OPS_SESSION_INVALID` | 401 | Cookie missing, expired, or revoked |
| `OPS_USER_DISABLED` | 403 | `is_active=false` |
| `OPS_TARGET_USER_NOT_FOUND` | 404 | `user_id` in path does not resolve |

---

## 7. Testing

Per CLAUDE.md §12 each module needs 80%+ unit coverage and integration tests on every controller endpoint.

Critical cases (more under [docs/testing.md](docs/testing.md) once written):

**ops/auth:**
- Login with valid creds + 2FA enabled → returns `challenge_id`, no session cookie set.
- Login with `totp_enabled=false` → `OPS_2FA_ENROLMENT_REQUIRED`.
- `verify-2fa` with valid TOTP → cookie set, `ops_sessions` row written.
- `verify-2fa` with stale challenge_id → `OPS_2FA_INVALID`.
- Disabled user cannot login.
- Customer `session` cookie does NOT authenticate against `OpsGuard`.
- Ops `ops_session` cookie does NOT authenticate against `SessionGuard`.

**ops/kyc:**
- `provision-va` on user with no existing VA → creates VA + audit row in same transaction.
- `provision-va` on user with existing VA → returns existing, no provider call, no duplicate audit row (idempotent).
- `provision-va` on user with no tier-1 KYC → `404` or `422`, no VA row, no audit row.
- `reset` and `revoke` write audit rows AND delete KycVerification rows in one transaction (parity with existing `revokeToTier`).
- All ops/kyc endpoints fail with `401` if called without `ops_session`.

**Audit log:**
- Every write endpoint writes exactly one `ops_audit_logs` row per success.
- Failed actions (exception thrown) write zero audit rows.
- Audit row records `ops_user_id`, `action`, `target_type='user'`, `target_id=<user_id>`.

---

## 8. Build order

Must have passing tests before each next phase.

| Phase | Build | Acceptance |
|---|---|---|
| 1 | Schema migration: `OpsUser`, `OpsSession`, `OpsAuditLog` | `prisma migrate dev` clean; `pnpm prisma generate` produces typed client |
| 2 | `OpsAuthService` + `OpsSessionService` + `OpsAuditService` + `OpsGuard` + `@CurrentOpsUser` | All unit tests pass; `OpsGuard` rejects customer cookies and vice-versa |
| 3 | `OpsAuthController` (login, verify-2fa, enrol-2fa, logout, me); add `.addCookieAuth('ops_session')` to existing `DocumentBuilder` in [main.ts](src/main.ts) | Integration tests pass; merged `/v1/docs` shows ops endpoints under `ops-*` tags |
| 4 | `scripts/create-ops-user.ts` + `disable-ops-user.ts` + `package.json` scripts | `pnpm ops:create-user --email=...` end-to-end works; can log in via curl |
| 5 | `OpsKycController` — wires `provision-va`, moves `reset`/`revoke`, adds `verifications` GET | Integration tests pass; audit rows written on every write |
| 6 | Delete `:user_id/reset` and `:user_id/revoke` from customer [kyc.controller.ts](src/modules/kyc/kyc.controller.ts); update Postman collection | `tsc --noEmit` clean; existing kyc tests still pass |

---

## 9. Resolved decisions

- **Session lifetime: 8h fixed, no sliding.** New constant `OPS_SESSION_TTL_SEC = 28_800` in [src/common/constants/index.ts](src/common/constants/index.ts) alongside the existing `SESSION_TTL_SEC = 86_400` (24h customer). Sliding renewal would add reissue logic and a "did my session just expire mid-action" failure mode for marginal UX gain — one workday, log in again tomorrow.
- **`request_id` propagation: explicit pass-through, no request-scoped DI.** The exception filter at [global-exception.filter.ts:28-29](src/common/filters/global-exception.filter.ts#L28-L29) already reads `x-request-id` directly off the request — there's no pino HTTP middleware generating one, just upstream pass-through. Match that: ops controllers read `req.headers['x-request-id']` and pass it explicitly into `OpsAuditService.write({ ..., request_id })`. If upstream omits the header, `request_id` is null on the audit row — same null-tolerance the error response body has today.
- **OpenAPI: single merged `/v1/docs`, ops endpoints under `ops-*` tags.** Add `.addCookieAuth('ops_session')` to the existing `DocumentBuilder` at [main.ts:48-54](src/main.ts#L48-L54) — one line. Hiding docs isn't access control (the endpoints are reachable either way); keeping one doc keeps client codegen and Postman exports single-source. If real leak protection becomes a concern later, gate Swagger UI itself behind ops auth or strip it from prod builds.
