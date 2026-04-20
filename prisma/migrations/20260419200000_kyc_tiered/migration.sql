-- Step 1: Drop old kycs table (and its FK) — no data to preserve
ALTER TABLE "kycs" DROP CONSTRAINT "kycs_user_id_fkey";
DROP TABLE "kycs";

-- Step 2: Drop old kyc_method enum (no longer referenced)
DROP TYPE "kyc_method";

-- Step 3: Rename MANUAL_REVIEW → UNDER_REVIEW in kyc_status
BEGIN;
CREATE TYPE "kyc_status_new" AS ENUM ('PENDING', 'UNDER_REVIEW', 'VERIFIED', 'FAILED');
ALTER TYPE "kyc_status" RENAME TO "kyc_status_old";
ALTER TYPE "kyc_status_new" RENAME TO "kyc_status";
DROP TYPE "kyc_status_old";
COMMIT;

-- Step 4: Create kyc_id_type enum
CREATE TYPE "kyc_id_type" AS ENUM ('BVN', 'NIN', 'PASSPORT');

-- Step 5: Add kyc_tier to users
ALTER TABLE "users" ADD COLUMN "kyc_tier" INTEGER NOT NULL DEFAULT 0;

-- Step 6: Create kyc_verifications table
CREATE TABLE "kyc_verifications" (
    "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
    "user_id"             UUID         NOT NULL,
    "tier"                INTEGER      NOT NULL,
    "id_type"             "kyc_id_type",
    "id_number_hash"      VARCHAR(512),
    "encrypted_id_number" VARCHAR(512),
    "legal_name"          VARCHAR(255),
    "date_of_birth"       DATE,
    "liveness_reference"  VARCHAR(255),
    "selfie_url"          VARCHAR(512),
    "address_line1"       VARCHAR(255),
    "address_city"        VARCHAR(100),
    "address_state"       VARCHAR(100),
    "address_doc_url"     VARCHAR(512),
    "status"              "kyc_status" NOT NULL DEFAULT 'PENDING',
    "failure_reason"      VARCHAR(500),
    "provider_reference"  VARCHAR(255),
    "verified_at"         TIMESTAMPTZ,
    "created_at"          TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMPTZ  NOT NULL,

    CONSTRAINT "kyc_verifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "kyc_verifications_user_id_tier_key" ON "kyc_verifications"("user_id", "tier");
CREATE INDEX "kyc_verifications_user_id_status_idx" ON "kyc_verifications"("user_id", "status");

ALTER TABLE "kyc_verifications"
  ADD CONSTRAINT "kyc_verifications_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
