-- Customer terms-acceptance stamp on every loan. Required for FCCPC / CBN
-- consumer-protection disclosure: proves we obtained explicit consent to the
-- fee breakdown (principal, origination, amount-to-receive, amount-to-repay)
-- before contract formation. New loans set this from the checkout DTO; this
-- migration backfills existing rows from created_at (those loans implicitly
-- accepted terms at the time they were created — pre-disclosure-rule data).
ALTER TABLE "loans" ADD COLUMN "terms_accepted_at" TIMESTAMPTZ;
UPDATE "loans" SET "terms_accepted_at" = "created_at" WHERE "terms_accepted_at" IS NULL;
ALTER TABLE "loans" ALTER COLUMN "terms_accepted_at" SET NOT NULL;
