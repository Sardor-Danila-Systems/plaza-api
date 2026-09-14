-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('UZS', 'USD');

-- CreateEnum
CREATE TYPE "FinancialTransactionType" AS ENUM ('INCOME', 'EXPENSE', 'SALARY', 'PURCHASE', 'ADVANCE', 'DEBT_PAYMENT', 'REFUND', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "TransactionDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "TransactionCategoryKind" AS ENUM ('INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "RateSource" AS ENUM ('MANUAL', 'PROVIDER');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "postingSequence" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "TransactionCategory" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "TransactionCategoryKind" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TransactionCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostedOperation" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "occurredAt" DATE NOT NULL,
    "postedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sequence" BIGINT NOT NULL,
    "cancelledAt" TIMESTAMPTZ(6),
    "cancellationReason" TEXT,
    "reversalOfId" UUID,

    CONSTRAINT "PostedOperation_pkey" PRIMARY KEY ("id"),
    -- Hand-added: Prisma's schema language cannot express cross-column
    -- conditional CHECKs (docs/adr/0008-manual-sql-check-constraints.md).
    -- `sequence` is `Project.postingSequence` post-increment (transaction-
    -- design.md §1), which starts at 0, so a posted sequence is always >= 1.
    CONSTRAINT "PostedOperation_sequence_positive_check" CHECK ("sequence" > 0),
    -- A cancellation always records why, together with when; there is no
    -- state where one of these is set without the other.
    CONSTRAINT "PostedOperation_cancellation_consistency_check" CHECK (
        ("cancelledAt" IS NULL AND "cancellationReason" IS NULL) OR
        ("cancelledAt" IS NOT NULL AND "cancellationReason" IS NOT NULL)
    ),
    -- Defense in depth: an operation cannot be its own reversal.
    CONSTRAINT "PostedOperation_reversal_not_self_check" CHECK (
        "reversalOfId" IS NULL OR "reversalOfId" <> "id"
    )
);

-- CreateTable
CREATE TABLE "FinancialTransaction" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "type" "FinancialTransactionType" NOT NULL,
    "direction" "TransactionDirection" NOT NULL,
    "amount" DECIMAL(24,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "exchangeRate" DECIMAL(24,8),
    "amountUzs" DECIMAL(24,2) NOT NULL,
    "rateSource" "RateSource" NOT NULL DEFAULT 'MANUAL',
    "rateId" UUID,
    "rateOverrideReason" TEXT,
    "categoryId" UUID,
    "categoryNameSnapshot" TEXT,
    "recipient" TEXT,
    "comment" TEXT,
    "occurredAt" DATE NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "cancelledAt" TIMESTAMPTZ(6),
    "cancellationReason" TEXT,
    "cancelledById" UUID,
    "reversalOfId" UUID,

    CONSTRAINT "FinancialTransaction_pkey" PRIMARY KEY ("id"),
    -- Hand-added: Prisma's schema language cannot express cross-column
    -- conditional CHECKs (docs/adr/0008-manual-sql-check-constraints.md).
    -- `amount` is always a positive magnitude; sign/direction lives
    -- separately in `direction`, never encoded as a negative amount.
    CONSTRAINT "FinancialTransaction_amount_positive_check" CHECK ("amount" > 0),
    CONSTRAINT "FinancialTransaction_amountUzs_positive_check" CHECK ("amountUzs" > 0),
    -- UZS is the ledger's own unit of account (no rate needed and none
    -- allowed); USD always carries an explicit, positive rate captured at
    -- posting time (docs/adr/0006-cross-currency-settlement-explicit-rate.md).
    CONSTRAINT "FinancialTransaction_currency_exchangeRate_check" CHECK (
        ("currency" = 'UZS' AND "exchangeRate" IS NULL) OR
        ("currency" = 'USD' AND "exchangeRate" IS NOT NULL AND "exchangeRate" > 0)
    ),
    -- `direction` is server-computed from `type`, never client input, but is
    -- still pinned here as a database-level backstop against a future bug
    -- (or direct-SQL insert) writing a mismatched pair. ADJUSTMENT is the
    -- one type without a fixed direction (deferred to whatever workflow
    -- eventually implements it).
    CONSTRAINT "FinancialTransaction_direction_matches_type_check" CHECK (
        ("type" IN ('INCOME', 'REFUND') AND "direction" = 'IN') OR
        ("type" IN ('EXPENSE', 'SALARY', 'PURCHASE', 'ADVANCE', 'DEBT_PAYMENT') AND "direction" = 'OUT') OR
        ("type" = 'ADJUSTMENT')
    ),
    -- A USD row's rate either comes straight from a recorded CurrencyRate
    -- (`rateId` set, no override reason needed) or was typed in directly,
    -- which requires explaining why (`rateId` null, override reason
    -- required). A UZS row has neither, since it carries no rate at all.
    CONSTRAINT "FinancialTransaction_rate_consistency_check" CHECK (
        ("currency" = 'UZS' AND "rateId" IS NULL AND "rateOverrideReason" IS NULL) OR
        ("currency" = 'USD' AND "rateId" IS NOT NULL AND "rateOverrideReason" IS NULL) OR
        ("currency" = 'USD' AND "rateId" IS NULL AND "rateOverrideReason" IS NOT NULL)
    ),
    -- A cancellation always records who, why and when together; there is no
    -- state where only some of these three are set.
    CONSTRAINT "FinancialTransaction_cancellation_consistency_check" CHECK (
        ("cancelledAt" IS NULL AND "cancellationReason" IS NULL AND "cancelledById" IS NULL) OR
        ("cancelledAt" IS NOT NULL AND "cancellationReason" IS NOT NULL AND "cancelledById" IS NOT NULL)
    ),
    -- Defense in depth: a row cannot be its own reversal.
    CONSTRAINT "FinancialTransaction_reversal_not_self_check" CHECK (
        "reversalOfId" IS NULL OR "reversalOfId" <> "id"
    )
);

-- CreateTable
CREATE TABLE "CurrencyRate" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "currency" "Currency" NOT NULL,
    "rateUzs" DECIMAL(24,8) NOT NULL,
    "effectiveOn" DATE NOT NULL,
    "source" "RateSource" NOT NULL DEFAULT 'MANUAL',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CurrencyRate_pkey" PRIMARY KEY ("id"),
    -- Hand-added: Prisma's schema language cannot express cross-column
    -- conditional CHECKs (docs/adr/0008-manual-sql-check-constraints.md).
    CONSTRAINT "CurrencyRate_rateUzs_positive_check" CHECK ("rateUzs" > 0),
    -- `currency` names the non-UZS side of the rate (see the column's doc
    -- comment in schema.prisma) — UZS itself is never a valid value here,
    -- since "1 UZS is worth N UZS" is meaningless.
    CONSTRAINT "CurrencyRate_currency_not_base_check" CHECK ("currency" <> 'UZS')
);

-- CreateIndex
CREATE INDEX "TransactionCategory_projectId_isActive_idx" ON "TransactionCategory"("projectId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionCategory_projectId_kind_name_key" ON "TransactionCategory"("projectId", "kind", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionCategory_projectId_id_key" ON "TransactionCategory"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PostedOperation_reversalOfId_key" ON "PostedOperation"("reversalOfId");

-- CreateIndex
CREATE INDEX "PostedOperation_projectId_cancelledAt_idx" ON "PostedOperation"("projectId", "cancelledAt");

-- CreateIndex
CREATE UNIQUE INDEX "PostedOperation_projectId_id_key" ON "PostedOperation"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PostedOperation_projectId_actorId_kind_idempotencyKey_key" ON "PostedOperation"("projectId", "actorId", "kind", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PostedOperation_projectId_sequence_key" ON "PostedOperation"("projectId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialTransaction_reversalOfId_key" ON "FinancialTransaction"("reversalOfId");

-- CreateIndex
CREATE INDEX "FinancialTransaction_projectId_occurredAt_idx" ON "FinancialTransaction"("projectId", "occurredAt");

-- CreateIndex
CREATE INDEX "FinancialTransaction_projectId_type_idx" ON "FinancialTransaction"("projectId", "type");

-- CreateIndex
CREATE INDEX "FinancialTransaction_projectId_categoryId_idx" ON "FinancialTransaction"("projectId", "categoryId");

-- CreateIndex
CREATE INDEX "FinancialTransaction_projectId_cancelledAt_idx" ON "FinancialTransaction"("projectId", "cancelledAt");

-- CreateIndex
CREATE INDEX "FinancialTransaction_operationId_idx" ON "FinancialTransaction"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialTransaction_projectId_id_key" ON "FinancialTransaction"("projectId", "id");

-- CreateIndex
CREATE INDEX "CurrencyRate_projectId_currency_effectiveOn_idx" ON "CurrencyRate"("projectId", "currency", "effectiveOn");

-- CreateIndex
CREATE UNIQUE INDEX "CurrencyRate_projectId_id_key" ON "CurrencyRate"("projectId", "id");

-- AddForeignKey
ALTER TABLE "TransactionCategory" ADD CONSTRAINT "TransactionCategory_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PostedOperation" ADD CONSTRAINT "PostedOperation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PostedOperation" ADD CONSTRAINT "PostedOperation_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PostedOperation" ADD CONSTRAINT "PostedOperation_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "PostedOperation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_projectId_operationId_fkey" FOREIGN KEY ("projectId", "operationId") REFERENCES "PostedOperation"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_projectId_rateId_fkey" FOREIGN KEY ("projectId", "rateId") REFERENCES "CurrencyRate"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_projectId_categoryId_fkey" FOREIGN KEY ("projectId", "categoryId") REFERENCES "TransactionCategory"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "FinancialTransaction"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CurrencyRate" ADD CONSTRAINT "CurrencyRate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CurrencyRate" ADD CONSTRAINT "CurrencyRate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
