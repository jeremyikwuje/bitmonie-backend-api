-- Truncate dev/test rows that pre-date origin tracking — no production data exists yet
TRUNCATE TABLE "price_feeds";

-- AlterTable
ALTER TABLE "price_feeds" ADD COLUMN "markup_percent"   DECIMAL(6,4)  NOT NULL,
                          ADD COLUMN "rate_buy_origin"  DECIMAL(20,6) NOT NULL,
                          ADD COLUMN "rate_sell_origin" DECIMAL(20,6) NOT NULL;
