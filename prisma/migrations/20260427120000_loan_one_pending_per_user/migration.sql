-- ─────────────────────────────────────────────────────────────────────────────
-- One PENDING_COLLATERAL loan per user
--
-- Customer must pay the collateral invoice or cancel the loan before starting
-- another. Race-proof guarantee at the DB layer; the service-layer count check
-- in LoansService.checkoutLoan provides a clean 409 in the common case.
--
-- Mirrors the partial unique pattern already used for collateral_topups
-- (one PENDING top-up per loan).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX "loans_user_id_pending_unique"
    ON "loans"("user_id")
    WHERE "status" = 'PENDING_COLLATERAL';
