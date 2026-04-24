-- AlterTable
ALTER TABLE "loans" ALTER COLUMN "daily_custody_fee_ngn" DROP DEFAULT,
ALTER COLUMN "initial_collateral_usd" DROP DEFAULT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "country" VARCHAR(2) NOT NULL DEFAULT 'NG';
