/*
  Warnings:

  - You are about to drop the column `loan_amount_ngn` on the `large_quote_enquiries` table. All the data in the column will be lost.
  - Added the required column `loan_amount` to the `large_quote_enquiries` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "disbursement_accounts_destination_unique_idx";

-- AlterTable
ALTER TABLE "large_quote_enquiries" DROP COLUMN "loan_amount_ngn",
ADD COLUMN     "loan_amount" DECIMAL(20,2) NOT NULL,
ADD COLUMN     "loan_currency" VARCHAR(10) NOT NULL DEFAULT 'NGN';
