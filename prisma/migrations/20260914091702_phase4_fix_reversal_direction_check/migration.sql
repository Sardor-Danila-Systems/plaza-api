-- Correction: docs/backend-architecture.md's cancellation rules are explicit
-- that a standalone reversal "creates an opposite-direction transaction of
-- the original business type" — i.e. a reversal of an INCOME row is itself
-- still `type = INCOME` but `direction = OUT`. The original
-- FinancialTransaction_direction_matches_type_check assumed type always
-- determines direction 1:1, which is only true for a NON-reversal row;
-- discovered by the e2e cancellation test actually exercising this path
-- against real Postgres (not merely asserted from the migration SQL, per
-- this project's empirical-verification discipline). Replace the check to
-- exempt any row with `reversalOfId IS NOT NULL`.
ALTER TABLE "FinancialTransaction" DROP CONSTRAINT "FinancialTransaction_direction_matches_type_check";

ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_direction_matches_type_check" CHECK (
    ("type" IN ('INCOME', 'REFUND') AND "direction" = 'IN') OR
    ("type" IN ('EXPENSE', 'SALARY', 'PURCHASE', 'ADVANCE', 'DEBT_PAYMENT') AND "direction" = 'OUT') OR
    ("type" = 'ADJUSTMENT') OR
    ("reversalOfId" IS NOT NULL)
);
