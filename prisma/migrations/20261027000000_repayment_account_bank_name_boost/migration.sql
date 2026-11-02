-- PalmPay VAs issued now (0100… numbers) are hosted by Boost MFB, not Bloom MFB.
-- Only the column default changes here; existing rows are corrected by
-- scripts/correct-repayment-account-bank-name.ts, which can be dry-run first.
ALTER TABLE "user_repayment_accounts" ALTER COLUMN "bank_name" SET DEFAULT 'Boost Microfinance Bank';
