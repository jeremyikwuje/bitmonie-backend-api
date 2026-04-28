-- Add provider_code to disbursements so the snapshot carries the machine
-- identifier (e.g. NIBSS sort code "058") that providers expect for transfers.
-- Without this, OutflowsService was passing the human-readable provider_name
-- ("GTBank") to PalmPay's payeeBankCode, which PalmPay rejected as
-- "bank code does not exist".
--
-- Best-effort backfill from disbursement_accounts: matches by (user_id,
-- provider_name, account_unique). Older rows that no longer have a matching
-- account row stay NULL — those are already terminal (CANCELLED) or stuck
-- ON_HOLD pending ops decision; new dispatches will always have provider_code.

ALTER TABLE "disbursements" ADD COLUMN "provider_code" VARCHAR(50);

UPDATE "disbursements" d
SET "provider_code" = da."provider_code"
FROM "disbursement_accounts" da
WHERE da."user_id"        = d."user_id"
  AND da."provider_name"  = d."provider_name"
  AND da."account_unique" = d."account_unique"
  AND d."provider_code" IS NULL;
