-- Passwordless auth + transaction PIN
--
-- 1. Drop User.password_hash. Customer login is now email-OTP only.
-- 2. Add transaction PIN fields. Opt-in second factor for sensitive ops
--    (release-address change). Never asked at login. Argon2id-hashed.
--
-- Ops auth (`ops_users`) is unchanged — internal staff still use
-- password + TOTP.

ALTER TABLE "users" DROP COLUMN "password_hash";

ALTER TABLE "users"
  ADD COLUMN "transaction_pin_hash"            VARCHAR(512),
  ADD COLUMN "transaction_pin_set_at"          TIMESTAMPTZ,
  ADD COLUMN "transaction_pin_failed_attempts" INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN "transaction_pin_locked_until"    TIMESTAMPTZ;
