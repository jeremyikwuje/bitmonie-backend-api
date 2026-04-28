-- ─────────────────────────────────────────────────────────────────────────────
-- Ops module — phase 1: identity, sessions, audit log
--
-- Separate domain from customer User so a customer signup can never inherit
-- ops powers, ops accounts can't take loans, and customer DTOs can't leak
-- ops-only fields. Mirrors customer auth machinery (opaque token, Argon2id,
-- TOTP) but with its own tables, cookie name (ops_session), and 8h TTL.
--
-- See docs/ops-module.md for the full design.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- ops_users: internal operator accounts. Provisioned via CLI
-- (pnpm ops:create-user). totp_secret is nullable until first server-side
-- enrolment via POST /v1/ops/auth/enrol-2fa; sessions are not issued until
-- totp_enabled=true (application-enforced, see OpsAuthService).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "ops_users" (
    "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
    "email"         VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(512) NOT NULL,
    "totp_secret"   VARCHAR(512),
    "totp_enabled"  BOOLEAN      NOT NULL DEFAULT FALSE,
    "full_name"     VARCHAR(200) NOT NULL,
    "is_active"     BOOLEAN      NOT NULL DEFAULT TRUE,
    "last_login_at" TIMESTAMPTZ,
    "created_at"    TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMPTZ  NOT NULL,

    CONSTRAINT "ops_users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ops_users_email_key" ON "ops_users"("email");

-- ─────────────────────────────────────────────────────────────────────────────
-- ops_sessions: opaque-token sessions for OpsGuard. Mirrors `sessions`.
-- Cascade on ops_user delete — disabled users lose all sessions immediately.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "ops_sessions" (
    "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
    "ops_user_id" UUID         NOT NULL,
    "token_hash"  VARCHAR(512) NOT NULL,
    "expires_at"  TIMESTAMPTZ  NOT NULL,
    "ip_address"  VARCHAR(45),
    "user_agent"  VARCHAR(512),
    "created_at"  TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ops_sessions_token_hash_key" ON "ops_sessions"("token_hash");

ALTER TABLE "ops_sessions"
    ADD CONSTRAINT "ops_sessions_ops_user_id_fkey"
    FOREIGN KEY ("ops_user_id") REFERENCES "ops_users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- ops_audit_logs: append-only ledger of every state-changing ops action.
-- Written in the same Prisma transaction as the action it records — same
-- discipline as loan_status_logs for loan state. RESTRICT on ops_user delete
-- so audit history can never be silently dropped by removing a user.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "ops_audit_logs" (
    "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
    "ops_user_id" UUID         NOT NULL,
    "action"      VARCHAR(100) NOT NULL,
    "target_type" VARCHAR(50)  NOT NULL,
    "target_id"   VARCHAR(100) NOT NULL,
    "details"     JSONB,
    "ip_address"  VARCHAR(45),
    "request_id"  VARCHAR(100),
    "created_at"  TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ops_audit_logs_ops_user_id_created_at_idx"
    ON "ops_audit_logs"("ops_user_id", "created_at");

CREATE INDEX "ops_audit_logs_target_type_target_id_created_at_idx"
    ON "ops_audit_logs"("target_type", "target_id", "created_at");

ALTER TABLE "ops_audit_logs"
    ADD CONSTRAINT "ops_audit_logs_ops_user_id_fkey"
    FOREIGN KEY ("ops_user_id") REFERENCES "ops_users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
