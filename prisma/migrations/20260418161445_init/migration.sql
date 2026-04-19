-- CreateEnum
CREATE TYPE "kyc_status" AS ENUM ('PENDING', 'VERIFIED', 'FAILED', 'MANUAL_REVIEW');

-- CreateEnum
CREATE TYPE "kyc_method" AS ENUM ('BVN', 'NIN', 'PASSPORT');

-- CreateEnum
CREATE TYPE "disbursement_account_kind" AS ENUM ('BANK', 'MOBILE_MONEY', 'CRYPTO_ADDRESS');

-- CreateEnum
CREATE TYPE "disbursement_account_status" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "payment_request_type" AS ENUM ('COLLATERAL', 'OFFRAMP_DEPOSIT');

-- CreateEnum
CREATE TYPE "payment_network" AS ENUM ('LIGHTNING', 'BTC_ONCHAIN', 'TRC20', 'ERC20');

-- CreateEnum
CREATE TYPE "payment_request_status" AS ENUM ('PENDING', 'PAID', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "disbursement_type" AS ENUM ('LOAN', 'OFFRAMP');

-- CreateEnum
CREATE TYPE "disbursement_rail" AS ENUM ('BANK_TRANSFER', 'MOBILE_MONEY', 'LIGHTNING', 'ONCHAIN');

-- CreateEnum
CREATE TYPE "disbursement_status" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESSFUL', 'FAILED');

-- CreateEnum
CREATE TYPE "outflow_status" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESSFUL', 'FAILED');

-- CreateEnum
CREATE TYPE "AssetPair" AS ENUM ('SAT_NGN', 'BTC_NGN', 'USDT_NGN', 'USDC_NGN');

-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('PENDING_COLLATERAL', 'ACTIVE', 'REPAID', 'LIQUIDATED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CollateralAsset" AS ENUM ('SAT');

-- CreateEnum
CREATE TYPE "RepaymentMethod" AS ENUM ('NGN', 'SAT');

-- CreateEnum
CREATE TYPE "status_trigger" AS ENUM ('CUSTOMER', 'SYSTEM', 'COLLATERAL_WEBHOOK', 'DISBURSEMENT_WEBHOOK');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(255) NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "password_hash" VARCHAR(512) NOT NULL,
    "totp_secret" VARCHAR(512),
    "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(512) NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "ip_address" VARCHAR(45),
    "user_agent" VARCHAR(512),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kycs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "method" "kyc_method" NOT NULL,
    "status" "kyc_status" NOT NULL DEFAULT 'PENDING',
    "bvn_hash" VARCHAR(512),
    "encrypted_bvn" VARCHAR(512),
    "legal_name" VARCHAR(255) NOT NULL,
    "verified_at" TIMESTAMPTZ,
    "failure_reason" VARCHAR(500),
    "provider_reference" VARCHAR(255),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "kycs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disbursement_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "kind" "disbursement_account_kind" NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "provider_name" VARCHAR(100) NOT NULL,
    "provider_code" VARCHAR(50) NOT NULL,
    "account_unique" VARCHAR(512) NOT NULL,
    "account_unique_tag" VARCHAR(100),
    "network" "payment_network",
    "label" VARCHAR(100),
    "account_holder_name" VARCHAR(255),
    "name_match_score" DOUBLE PRECISION,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "status" "disbursement_account_status" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "verified_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "disbursement_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "request_type" "payment_request_type" NOT NULL,
    "source_type" VARCHAR(50) NOT NULL,
    "source_id" UUID NOT NULL,
    "asset" VARCHAR(20) NOT NULL,
    "network" "payment_network" NOT NULL,
    "expected_amount" DECIMAL(20,8) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "receiving_address" VARCHAR(512) NOT NULL,
    "payment_request" TEXT,
    "provider_reference" VARCHAR(512),
    "status" "payment_request_status" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ NOT NULL,
    "paid_at" TIMESTAMPTZ,
    "inflow_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "payment_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inflows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "asset" VARCHAR(20) NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "network" "payment_network" NOT NULL,
    "receiving_address" VARCHAR(512) NOT NULL,
    "sender_address" VARCHAR(512),
    "provider_reference" VARCHAR(512) NOT NULL,
    "confirmations_required" INTEGER,
    "confirmations_received" INTEGER NOT NULL DEFAULT 0,
    "block_number" BIGINT,
    "block_timestamp" TIMESTAMPTZ,
    "is_matched" BOOLEAN NOT NULL DEFAULT false,
    "matched_at" TIMESTAMPTZ,
    "source_type" VARCHAR(50),
    "source_id" UUID,
    "provider_response" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "inflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disbursements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "disbursement_type" "disbursement_type" NOT NULL,
    "disbursement_rail" "disbursement_rail" NOT NULL,
    "source_type" "disbursement_type" NOT NULL,
    "source_id" UUID NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "provider_name" VARCHAR(255) NOT NULL,
    "account_unique" VARCHAR(512) NOT NULL,
    "account_name" VARCHAR(255),
    "status" "disbursement_status" NOT NULL DEFAULT 'PENDING',
    "failure_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "disbursements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outflows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "disbursement_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL DEFAULT 1,
    "provider" VARCHAR(100) NOT NULL,
    "provider_reference" VARCHAR(512) NOT NULL,
    "provider_tx_id" VARCHAR(512),
    "provider_response" JSONB,
    "status" "outflow_status" NOT NULL DEFAULT 'PENDING',
    "failure_reason" VARCHAR(500),
    "failure_code" VARCHAR(100),
    "initiated_at" TIMESTAMPTZ,
    "confirmed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "outflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_feeds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pair" "AssetPair" NOT NULL,
    "rate_buy" DECIMAL(20,6) NOT NULL,
    "rate_sell" DECIMAL(20,6) NOT NULL,
    "source" VARCHAR(50) NOT NULL,
    "fetched_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_feeds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "disbursement_account_id" UUID NOT NULL,
    "collateral_asset" "CollateralAsset" NOT NULL DEFAULT 'SAT',
    "collateral_amount_sat" BIGINT NOT NULL,
    "ltv_percent" DECIMAL(5,2) NOT NULL,
    "principal_ngn" DECIMAL(20,2) NOT NULL,
    "origination_fee_ngn" DECIMAL(20,2) NOT NULL,
    "daily_fee_ngn" DECIMAL(20,2) NOT NULL,
    "duration_days" INTEGER NOT NULL,
    "total_fees_ngn" DECIMAL(20,2) NOT NULL,
    "total_amount_ngn" DECIMAL(20,2) NOT NULL,
    "sat_ngn_rate_at_creation" DECIMAL(20,6) NOT NULL,
    "liquidation_rate_ngn" DECIMAL(20,6) NOT NULL,
    "alert_rate_ngn" DECIMAL(20,6) NOT NULL,
    "status" "LoanStatus" NOT NULL DEFAULT 'PENDING_COLLATERAL',
    "collateral_received_at" TIMESTAMPTZ,
    "disbursement_id" UUID,
    "repayment_method" "RepaymentMethod",
    "repayment_reference" VARCHAR(512),
    "repaid_at" TIMESTAMPTZ,
    "collateral_release_address" VARCHAR(512),
    "collateral_released_at" TIMESTAMPTZ,
    "collateral_release_reference" VARCHAR(512),
    "liquidated_at" TIMESTAMPTZ,
    "liquidation_reference" VARCHAR(512),
    "liquidation_rate_actual" DECIMAL(20,6),
    "surplus_released_sat" BIGINT,
    "due_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_status_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "loan_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "from_status" "LoanStatus",
    "to_status" "LoanStatus" NOT NULL,
    "triggered_by" "status_trigger" NOT NULL,
    "triggered_by_id" VARCHAR(255),
    "reason_code" VARCHAR(100) NOT NULL,
    "reason_detail" VARCHAR(500),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loan_status_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "action" VARCHAR(255) NOT NULL,
    "resource" VARCHAR(255),
    "ip_address" VARCHAR(45),
    "user_agent" VARCHAR(512),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "large_quote_enquiries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "loan_amount_ngn" DECIMAL(20,2) NOT NULL,
    "collateral_type" VARCHAR(50) NOT NULL,
    "preferred_contact" VARCHAR(20) NOT NULL,
    "notes" VARCHAR(1000),
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "large_quote_enquiries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "kycs_user_id_key" ON "kycs"("user_id");

-- CreateIndex
CREATE INDEX "disbursement_accounts_user_id_kind_status_idx" ON "disbursement_accounts"("user_id", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payment_requests_inflow_id_key" ON "payment_requests"("inflow_id");

-- CreateIndex
CREATE INDEX "payment_requests_source_type_source_id_idx" ON "payment_requests"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "payment_requests_receiving_address_idx" ON "payment_requests"("receiving_address");

-- CreateIndex
CREATE INDEX "payment_requests_status_expires_at_idx" ON "payment_requests"("status", "expires_at");

-- CreateIndex
CREATE INDEX "payment_requests_user_id_created_at_idx" ON "payment_requests"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "inflows_provider_reference_key" ON "inflows"("provider_reference");

-- CreateIndex
CREATE INDEX "inflows_receiving_address_idx" ON "inflows"("receiving_address");

-- CreateIndex
CREATE INDEX "inflows_provider_reference_idx" ON "inflows"("provider_reference");

-- CreateIndex
CREATE INDEX "inflows_is_matched_created_at_idx" ON "inflows"("is_matched", "created_at");

-- CreateIndex
CREATE INDEX "inflows_source_type_source_id_idx" ON "inflows"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "inflows_user_id_created_at_idx" ON "inflows"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "disbursements_user_id_created_at_idx" ON "disbursements"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "disbursements_source_type_source_id_idx" ON "disbursements"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "disbursements_status_created_at_idx" ON "disbursements"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "outflows_provider_reference_key" ON "outflows"("provider_reference");

-- CreateIndex
CREATE INDEX "outflows_disbursement_id_attempt_number_idx" ON "outflows"("disbursement_id", "attempt_number");

-- CreateIndex
CREATE INDEX "outflows_provider_status_idx" ON "outflows"("provider", "status");

-- CreateIndex
CREATE INDEX "outflows_status_created_at_idx" ON "outflows"("status", "created_at");

-- CreateIndex
CREATE INDEX "price_feeds_pair_fetched_at_idx" ON "price_feeds"("pair", "fetched_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "loans_disbursement_id_key" ON "loans"("disbursement_id");

-- CreateIndex
CREATE INDEX "loans_user_id_created_at_idx" ON "loans"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "loans_status_idx" ON "loans"("status");

-- CreateIndex
CREATE INDEX "loan_status_logs_loan_id_created_at_idx" ON "loan_status_logs"("loan_id", "created_at");

-- CreateIndex
CREATE INDEX "loan_status_logs_user_id_created_at_idx" ON "loan_status_logs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kycs" ADD CONSTRAINT "kycs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disbursement_accounts" ADD CONSTRAINT "disbursement_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_inflow_id_fkey" FOREIGN KEY ("inflow_id") REFERENCES "inflows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inflows" ADD CONSTRAINT "inflows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outflows" ADD CONSTRAINT "outflows_disbursement_id_fkey" FOREIGN KEY ("disbursement_id") REFERENCES "disbursements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_disbursement_account_id_fkey" FOREIGN KEY ("disbursement_account_id") REFERENCES "disbursement_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_disbursement_id_fkey" FOREIGN KEY ("disbursement_id") REFERENCES "disbursements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_status_logs" ADD CONSTRAINT "loan_status_logs_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "loans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DisbursementAccount — destination uniqueness per (user, kind).
-- NULLS NOT DISTINCT so (network IS NULL) still collides for BANK / MOBILE_MONEY duplicates.
CREATE UNIQUE INDEX "disbursement_accounts_destination_unique_idx"
  ON "disbursement_accounts" ("user_id", "kind", "provider_code", "network", "account_unique")
  NULLS NOT DISTINCT;

-- DisbursementAccount — at most one default per (user, kind).
CREATE UNIQUE INDEX "disbursement_accounts_one_default_per_kind_idx"
  ON "disbursement_accounts" ("user_id", "kind")
  WHERE "is_default" = true;
