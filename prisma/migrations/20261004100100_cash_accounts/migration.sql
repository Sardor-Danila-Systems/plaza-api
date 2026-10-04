-- 1. CASHIER is project-scoped exactly like PROJECT_MANAGER: a projectId is
--    required for both and forbidden for everyone else. The one-active-
--    manager partial unique index is untouched — it is keyed on
--    role = 'PROJECT_MANAGER', so a project may have any number of cashiers.
ALTER TABLE "User" DROP CONSTRAINT "User_role_projectId_check";
ALTER TABLE "User" ADD CONSTRAINT "User_role_projectId_check" CHECK (
    ("role" IN ('PROJECT_MANAGER', 'CASHIER') AND "projectId" IS NOT NULL) OR
    ("role" NOT IN ('PROJECT_MANAGER', 'CASHIER') AND "projectId" IS NULL)
);

-- 2. Two cash accounts per project. Every existing row was physical cash,
--    hence the default — no backfill beyond it is needed.
CREATE TYPE "CashAccount" AS ENUM ('CASH', 'BANK');
ALTER TABLE "FinancialTransaction"
    ADD COLUMN "account" "CashAccount" NOT NULL DEFAULT 'CASH';

-- Balances (and every insufficient-cash check) are now summed per account.
CREATE INDEX "FinancialTransaction_projectId_account_currency_idx"
    ON "FinancialTransaction"("projectId", "account", "currency");
