/*
  Warnings:

  - Made the column `exchangeRate` on table `FinancialTransaction` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "FinancialTransaction" ALTER COLUMN "exchangeRate" SET NOT NULL;

-- Correction: the original phase4_finance migration's
-- FinancialTransaction_currency_exchangeRate_check assumed exchangeRate was
-- null for UZS. docs/backend-architecture.md §4 is explicit that it is
-- always populated ("For UZS, exchangeRate = 1 and amountUzs = amount. For
-- USD, amountUzs = round2(amount * exchangeRate)") — replace the check to
-- match the approved architecture rather than the earlier draft.
ALTER TABLE "FinancialTransaction" DROP CONSTRAINT "FinancialTransaction_currency_exchangeRate_check";

ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_currency_exchangeRate_check" CHECK (
    ("currency" = 'UZS' AND "exchangeRate" = 1) OR
    ("currency" = 'USD' AND "exchangeRate" > 0)
);
