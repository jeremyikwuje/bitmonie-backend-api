-- ─────────────────────────────────────────────────────────────────────────────
-- Public loan-application intake form.
--
-- Backs POST /v1/loan-applications — unauthenticated form submission from
-- bitmonie.com/apply. Two persona groups bypass self-serve:
--   1. Non-BTC asset owners wanting OTC handling against physical collateral
--      (cars, MacBooks, iPhones, USDT/USDC).
--   2. BTC owners who prefer human-assisted onboarding.
-- Loans team triages by hand.
--
-- `loan_amount_ngn` carries a CHECK constraint at the DB layer in addition to
-- the DTO's `@Max(100_000_000)` — defense in depth against any future caller
-- bypassing the controller validation.
--
-- See docs/loan-applications.md.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TYPE "LoanApplicationStatus" AS ENUM ('NEW', 'CONTACTED', 'APPROVED', 'REJECTED', 'CLOSED');

CREATE TYPE "LoanApplicationCollateralType" AS ENUM (
    'BITCOIN',
    'USDT_USDC',
    'MACBOOK_M1_OR_NEWER',
    'IPHONE_13_OR_NEWER',
    'CAR_2008_OR_NEWER'
);

CREATE TABLE "loan_applications" (
    "id"                      UUID                            NOT NULL DEFAULT gen_random_uuid(),
    "created_at"              TIMESTAMPTZ                     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"              TIMESTAMPTZ                     NOT NULL,

    "first_name"              VARCHAR(80)                     NOT NULL,
    "last_name"               VARCHAR(80)                     NOT NULL,
    "email"                   VARCHAR(160)                    NOT NULL,
    "phone"                   VARCHAR(40)                     NOT NULL,

    "collateral_type"         "LoanApplicationCollateralType" NOT NULL,
    "collateral_description"  VARCHAR(1000),
    "loan_amount_ngn"         DECIMAL(20, 2)                  NOT NULL,

    "status"                  "LoanApplicationStatus"         NOT NULL DEFAULT 'NEW',
    "assigned_to_ops_user_id" UUID,
    "notes"                   TEXT,

    "client_ip"               VARCHAR(45),
    "user_agent"              VARCHAR(512),

    CONSTRAINT "loan_applications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "loan_applications_loan_amount_ngn_check"
        CHECK ("loan_amount_ngn" > 0 AND "loan_amount_ngn" <= 100000000)
);

CREATE INDEX "loan_applications_email_idx"      ON "loan_applications"("email");
CREATE INDEX "loan_applications_created_at_idx" ON "loan_applications"("created_at" DESC);
CREATE INDEX "loan_applications_status_idx"     ON "loan_applications"("status");

ALTER TABLE "loan_applications"
    ADD CONSTRAINT "loan_applications_assigned_to_ops_user_id_fkey"
    FOREIGN KEY ("assigned_to_ops_user_id") REFERENCES "ops_users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
