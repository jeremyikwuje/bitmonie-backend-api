-- A user can now hold more than one repayment VA: the current one (active) and
-- any it replaced. The Bloom MFB (99…) VAs are being replaced with Boost MFB
-- (0100…) ones. A replaced row is kept, inactive, so a transfer into the old
-- VA still routes to its owner.
ALTER TABLE "user_repayment_accounts"
    ADD COLUMN "is_active"      BOOLEAN     NOT NULL DEFAULT true,
    ADD COLUMN "deactivated_at" TIMESTAMPTZ;

DROP INDEX "user_repayment_accounts_user_id_key";
CREATE INDEX "user_repayment_accounts_user_id_idx" ON "user_repayment_accounts"("user_id");

-- At most one active VA per user.
CREATE UNIQUE INDEX "user_repayment_accounts_one_active_per_user_idx"
  ON "user_repayment_accounts" ("user_id")
  WHERE "is_active" = true;
