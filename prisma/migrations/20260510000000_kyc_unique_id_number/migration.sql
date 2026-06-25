-- ─────────────────────────────────────────────────────────────────────────────
-- One user per BVN / NIN / passport / drivers-license number.
--
-- `id_number_hash` is now computed deterministically from a server-side pepper
-- (KYC_ID_HASH_PEPPER) — see CryptoService.hashKycIdNumber. With a stable hash
-- per ID number, a unique index enforces the "one user per ID" rule at the DB
-- layer; the service-layer pre-check in KycService.submitTier1 returns a clean
-- 409 in the common case.
--
-- Predicate `WHERE id_type IS NOT NULL` scopes the constraint to tier-1 rows
-- that actually carry an ID number. Tier-2/tier-3 rows have NULL id_type +
-- NULL id_number_hash and are deliberately excluded.
--
-- ⚠️ Existing rows produced by the legacy per-row random-salt scheme need to
-- be rehashed with the new pepper before they participate in uniqueness
-- checks. Sequence in production:
--   1. Set KYC_ID_HASH_PEPPER in env.
--   2. Apply THIS migration (creates the index — succeeds because all legacy
--      hashes are unique by virtue of their random salts).
--   3. Run `pnpm ops:rehash-kyc-ids -- --apply` (decrypt encrypted_id_number,
--      recompute hash with the pepper, write back). Conflicts surface as
--      P2002 against this index for ops to resolve.
-- The dev DB is reset routinely so step 3 is a no-op there.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX "kyc_verifications_id_type_id_number_hash_unique"
    ON "kyc_verifications"("id_type", "id_number_hash")
    WHERE "id_type" IS NOT NULL;
