-- v1.2 — Open-term loans + margin-call safety model.
--
-- Loans no longer have a duration or maturity date. The customer borrows,
-- accrual ticks daily until repayment, and the only forced-close path is
-- LTV breach (collateral coverage < 1.10). Customer-facing nudges fire at
-- coverage < 1.20 (WARN) and < 1.15 (MARGIN_CALL) — both notification-only,
-- no DB column needed (Redis handles the dedupe/recovery state).
--
-- See docs/anytime-loans.md.

ALTER TABLE "loans" DROP COLUMN "duration_days";
ALTER TABLE "loans" DROP COLUMN "due_at";
