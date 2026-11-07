-- The origination fee moves from "netted from the disbursement" to "owed and
-- collected at repayment". New loans disburse the full principal; the fee is
-- part of outstanding and paid through the repayment waterfall
-- (custody → origination → interest → principal → overpay).
ALTER TABLE "loans"
    ADD COLUMN "origination_fee_netted" BOOLEAN NOT NULL DEFAULT false;

-- Loans priced before this change had their fee netted at disbursement — it
-- was already collected and must never show up as owed. Every such loan is
-- terminal at the time of this migration.
UPDATE "loans" SET "origination_fee_netted" = true WHERE "origination_fee_ngn" > 0;

ALTER TABLE "loan_repayments"
    ADD COLUMN "applied_to_origination" DECIMAL(20,2) NOT NULL DEFAULT 0;
