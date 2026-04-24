-- ─────────────────────────────────────────────────────────────────────────────
-- Loan v1.1 schema: accrual-based pricing, partial repayments, add-collateral,
-- per-user (not per-loan) PalmPay repayment VAs.
-- See docs/repayment-matching-redesign.md for the full design.
-- ─────────────────────────────────────────────────────────────────────────────

-- Add BANK_TRANSFER to PaymentNetwork enum (PalmPay virtual account inflows)
ALTER TYPE "payment_network" ADD VALUE IF NOT EXISTS 'BANK_TRANSFER';

-- ─────────────────────────────────────────────────────────────────────────────
-- loans: drop columns that lose meaning under accrual-based pricing
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "loans"
    DROP COLUMN "daily_fee_ngn",
    DROP COLUMN "total_fees_ngn",
    DROP COLUMN "total_amount_ngn",
    DROP COLUMN "liquidation_rate_ngn",
    DROP COLUMN "alert_rate_ngn";

-- loans: add accrual inputs
ALTER TABLE "loans"
    ADD COLUMN "daily_interest_rate_bps" INTEGER        NOT NULL DEFAULT 30,
    ADD COLUMN "daily_custody_fee_ngn"   DECIMAL(20, 2) NOT NULL DEFAULT 0,
    ADD COLUMN "initial_collateral_usd"  DECIMAL(20, 2) NOT NULL DEFAULT 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- user_repayment_accounts: one permanent PalmPay VA per user (tied to BVN)
-- Replaces the per-loan loan_repayment_accounts design entirely.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "user_repayment_accounts" (
    "id"                   UUID         NOT NULL DEFAULT gen_random_uuid(),
    "user_id"              UUID         NOT NULL,
    "virtual_account_no"   VARCHAR(50)  NOT NULL,
    "virtual_account_name" VARCHAR(255) NOT NULL,
    "provider"             VARCHAR(50)  NOT NULL,
    "provider_reference"   VARCHAR(255),
    "created_at"           TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_repayment_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_repayment_accounts_user_id_key"
    ON "user_repayment_accounts"("user_id");

CREATE UNIQUE INDEX "user_repayment_accounts_virtual_account_no_key"
    ON "user_repayment_accounts"("virtual_account_no");

ALTER TABLE "user_repayment_accounts"
    ADD CONSTRAINT "user_repayment_accounts_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- loan_repayments: append-only ledger of credited repayment inflows
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "loan_repayments" (
    "id"                   UUID           NOT NULL DEFAULT gen_random_uuid(),
    "loan_id"              UUID           NOT NULL,
    "inflow_id"            UUID           NOT NULL,
    "amount_ngn"           DECIMAL(20, 2) NOT NULL,
    "applied_to_principal" DECIMAL(20, 2) NOT NULL,
    "applied_to_interest"  DECIMAL(20, 2) NOT NULL,
    "applied_to_custody"   DECIMAL(20, 2) NOT NULL,
    "overpay_ngn"          DECIMAL(20, 2) NOT NULL DEFAULT 0,
    "match_method"         VARCHAR(20)    NOT NULL,
    "created_at"           TIMESTAMPTZ    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loan_repayments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "loan_repayments_inflow_id_key"
    ON "loan_repayments"("inflow_id");

CREATE INDEX "loan_repayments_loan_id_created_at_idx"
    ON "loan_repayments"("loan_id", "created_at");

ALTER TABLE "loan_repayments"
    ADD CONSTRAINT "loan_repayments_loan_id_fkey"
    FOREIGN KEY ("loan_id") REFERENCES "loans"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "loan_repayments"
    ADD CONSTRAINT "loan_repayments_inflow_id_fkey"
    FOREIGN KEY ("inflow_id") REFERENCES "inflows"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- collateral_topups: customer-initiated BTC top-ups on ACTIVE loans
-- Partial unique index enforces "at most one open top-up per loan".
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "topup_status" AS ENUM ('PENDING_COLLATERAL', 'RECEIVED', 'EXPIRED', 'CANCELLED');

CREATE TABLE "collateral_topups" (
    "id"                      UUID           NOT NULL DEFAULT gen_random_uuid(),
    "loan_id"                 UUID           NOT NULL,
    "collateral_provider"     VARCHAR(50)    NOT NULL,
    "collateral_provider_ref" VARCHAR(255)   NOT NULL,
    "payment_request"         VARCHAR(2000)  NOT NULL,
    "receiving_address"       VARCHAR(512)   NOT NULL,
    "expected_amount_sat"     BIGINT         NOT NULL,
    "expires_at"              TIMESTAMPTZ    NOT NULL,
    "received_amount_sat"     BIGINT,
    "received_at"             TIMESTAMPTZ,
    "status"                  "topup_status" NOT NULL DEFAULT 'PENDING_COLLATERAL',
    "created_at"              TIMESTAMPTZ    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"              TIMESTAMPTZ    NOT NULL,

    CONSTRAINT "collateral_topups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "collateral_topups_collateral_provider_ref_key"
    ON "collateral_topups"("collateral_provider_ref");

CREATE INDEX "collateral_topups_loan_id_status_idx"
    ON "collateral_topups"("loan_id", "status");

-- Partial unique index: at most one PENDING_COLLATERAL top-up per loan at a time
CREATE UNIQUE INDEX "collateral_topups_loan_id_pending_unique"
    ON "collateral_topups"("loan_id")
    WHERE "status" = 'PENDING_COLLATERAL';

ALTER TABLE "collateral_topups"
    ADD CONSTRAINT "collateral_topups_loan_id_fkey"
    FOREIGN KEY ("loan_id") REFERENCES "loans"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
