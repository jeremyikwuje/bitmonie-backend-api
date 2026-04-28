-- ─────────────────────────────────────────────────────────────────────────────
-- Disbursement: drop FAILED, add ON_HOLD + CANCELLED + ops cancellation metadata
--
-- Per CLAUDE.md §5.6: a Disbursement is the obligation; it never auto-fails.
-- Outflow attempts can FAIL; when one does, the parent Disbursement lands in
-- ON_HOLD pending an ops decision (retry → new Outflow attempt, or
-- CANCELLED with reason). No automatic retry.
--
-- Data-preserving: any rows currently in 'FAILED' are migrated to 'ON_HOLD'
-- (with on_hold_at backfilled from updated_at, alerted_at left NULL so ops
-- can re-discover them via the next digest).
--
-- Postgres can't drop an enum value in place, so the standard pattern: rename
-- the existing type, create the new type, ALTER COLUMN ... USING ..., drop
-- the old type.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Rename the existing enum out of the way.
ALTER TYPE "disbursement_status" RENAME TO "disbursement_status_old";

-- 2. Create the new enum with the v1.1 vocabulary.
CREATE TYPE "disbursement_status" AS ENUM (
    'PENDING',
    'PROCESSING',
    'ON_HOLD',
    'SUCCESSFUL',
    'CANCELLED'
);

-- 3. Drop the default before the type change (Postgres requires this when
--    casting between enum types).
ALTER TABLE "disbursements" ALTER COLUMN "status" DROP DEFAULT;

-- 4. Cast every existing row to the new enum, mapping FAILED → ON_HOLD.
ALTER TABLE "disbursements"
    ALTER COLUMN "status" TYPE "disbursement_status"
    USING (
        CASE "status"::text
            WHEN 'FAILED' THEN 'ON_HOLD'::"disbursement_status"
            ELSE "status"::text::"disbursement_status"
        END
    );

-- 5. Restore the default.
ALTER TABLE "disbursements" ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- 6. Drop the legacy enum type.
DROP TYPE "disbursement_status_old";

-- ─────────────────────────────────────────────────────────────────────────────
-- New columns
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "disbursements"
    ADD COLUMN "on_hold_at"               TIMESTAMPTZ,
    ADD COLUMN "on_hold_alerted_at"       TIMESTAMPTZ,
    ADD COLUMN "cancelled_at"             TIMESTAMPTZ,
    ADD COLUMN "cancelled_by_ops_user_id" UUID,
    ADD COLUMN "cancellation_reason"      VARCHAR(500);

-- 7. Backfill on_hold_at for rows we just migrated from FAILED → ON_HOLD.
--    updated_at is the most reliable proxy for "when this last changed
--    state". on_hold_alerted_at stays NULL so the next digest re-surfaces
--    them (matches the "first-transition + daily digest" rule).
UPDATE "disbursements"
   SET "on_hold_at" = "updated_at"
 WHERE "status" = 'ON_HOLD'
   AND "on_hold_at" IS NULL;

-- 8. FK to ops_users — RESTRICT so we never silently lose the audit pointer
--    by deleting an ops user that has cancelled disbursements.
ALTER TABLE "disbursements"
    ADD CONSTRAINT "disbursements_cancelled_by_ops_user_id_fkey"
    FOREIGN KEY ("cancelled_by_ops_user_id") REFERENCES "ops_users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 9. Partial index for the daily-digest worker — scans only ON_HOLD rows
--    ordered by how long they've been stuck.
CREATE INDEX "disbursements_status_on_hold_at_idx"
    ON "disbursements" ("status", "on_hold_at");
