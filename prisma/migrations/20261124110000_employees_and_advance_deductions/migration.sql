-- Employees, salary-advance deductions and the narrow zero-cash payout rule.
CREATE TABLE "Employee" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Employee_projectId_id_key" ON "Employee"("projectId", "id");
CREATE INDEX "Employee_projectId_isActive_idx" ON "Employee"("projectId", "isActive");
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "FinancialTransaction" ADD COLUMN "employeeId" UUID;
ALTER TABLE "FinancialTransaction" ADD COLUMN "accruedAmount" DECIMAL(24,2);
ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_projectId_employeeId_fkey" FOREIGN KEY ("projectId", "employeeId") REFERENCES "Employee"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "AdvanceDeduction" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "advanceId" UUID NOT NULL,
    "payoutId" UUID NOT NULL,
    "amount" DECIMAL(24,2) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdvanceDeduction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AdvanceDeduction_amount_positive_check" CHECK ("amount" > 0)
);
CREATE UNIQUE INDEX "AdvanceDeduction_advanceId_payoutId_key" ON "AdvanceDeduction"("advanceId", "payoutId");
CREATE INDEX "AdvanceDeduction_projectId_advanceId_idx" ON "AdvanceDeduction"("projectId", "advanceId");
CREATE INDEX "AdvanceDeduction_projectId_payoutId_idx" ON "AdvanceDeduction"("projectId", "payoutId");
ALTER TABLE "AdvanceDeduction" ADD CONSTRAINT "AdvanceDeduction_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AdvanceDeduction" ADD CONSTRAINT "AdvanceDeduction_projectId_advanceId_fkey" FOREIGN KEY ("projectId", "advanceId") REFERENCES "FinancialTransaction"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AdvanceDeduction" ADD CONSTRAINT "AdvanceDeduction_projectId_payoutId_fkey" FOREIGN KEY ("projectId", "payoutId") REFERENCES "FinancialTransaction"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Zero amount is allowed ONLY for a salary payout (not an advance) whose
-- accrued amount is positive, i.e. fully covered by deducted advances.
-- Every other row still needs amount > 0.
ALTER TABLE "FinancialTransaction" DROP CONSTRAINT "FinancialTransaction_amount_positive_check";
ALTER TABLE "FinancialTransaction" DROP CONSTRAINT "FinancialTransaction_amountUzs_positive_check";
ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_amount_positive_check" CHECK (
    "amount" > 0 OR ("amount" = 0 AND "type" = 'SALARY' AND "isAdvance" = false AND "accruedAmount" IS NOT NULL AND "accruedAmount" > 0)
);
ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_amountUzs_positive_check" CHECK (
    "amountUzs" > 0 OR ("amountUzs" = 0 AND "amount" = 0)
);
-- accruedAmount is meaningful only for a non-advance SALARY row and can never
-- be below the cash actually paid.
ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_accrued_check" CHECK (
    "accruedAmount" IS NULL OR ("type" = 'SALARY' AND "isAdvance" = false AND "accruedAmount" >= "amount")
);
