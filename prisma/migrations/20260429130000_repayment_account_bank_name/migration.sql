-- Add `bank_name` to user_repayment_accounts. PalmPay's createVirtualAccount
-- response does NOT include the host bank (the "Account Suffix of Institution"
-- it returns is just a label — not the routable bank). For PalmPay-hosted VAs
-- the actual partner bank that customers see on their transfer screen is
-- Bloom Microfinance Bank, which we default at both the column and provider
-- layers so existing rows backfill non-destructively.
ALTER TABLE "user_repayment_accounts"
  ADD COLUMN "bank_name" VARCHAR(100) NOT NULL DEFAULT 'Bloom Microfinance Bank';
