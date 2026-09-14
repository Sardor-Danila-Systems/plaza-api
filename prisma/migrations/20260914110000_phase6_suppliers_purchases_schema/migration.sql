-- CreateEnum
CREATE TYPE "SupplierPaymentPurpose" AS ENUM ('PURCHASE_CASH', 'DEBT_PAYMENT', 'ADVANCE_FUNDING');

-- CreateEnum
CREATE TYPE "SettlementEffect" AS ENUM ('APPLY', 'REVERSE');

-- AlterTable
ALTER TABLE "FinancialTransaction" ADD COLUMN     "supplierPaymentId" UUID;

-- CreateTable
CREATE TABLE "Supplier" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contactPerson" TEXT,
    "phone" TEXT,
    "comment" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Purchase" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "supplierNameSnapshot" TEXT NOT NULL,
    "warehouseId" UUID NOT NULL,
    "warehouseNameSnapshot" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "exchangeRate" DECIMAL(24,8) NOT NULL,
    "rateSource" "RateSource" NOT NULL DEFAULT 'MANUAL',
    "rateId" UUID,
    "rateOverrideReason" TEXT,
    "totalAmount" DECIMAL(24,2) NOT NULL,
    "totalAmountUzs" DECIMAL(24,2) NOT NULL,
    "invoiceNumber" TEXT,
    "comment" TEXT,
    "occurredAt" DATE NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "cancelledAt" TIMESTAMPTZ(6),
    "cancellationReason" TEXT,
    "cancelledById" UUID,

    CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id"),
    -- Hand-added: Prisma's schema language cannot express these
    -- (docs/adr/0008-manual-sql-check-constraints.md). Same shape as
    -- FinancialTransaction's own checks.
    CONSTRAINT "Purchase_totalAmount_positive_check" CHECK ("totalAmount" > 0),
    CONSTRAINT "Purchase_totalAmountUzs_positive_check" CHECK ("totalAmountUzs" > 0),
    CONSTRAINT "Purchase_currency_exchangeRate_check" CHECK (
        ("currency" = 'UZS' AND "exchangeRate" = 1) OR
        ("currency" = 'USD' AND "exchangeRate" > 0)
    ),
    CONSTRAINT "Purchase_rate_consistency_check" CHECK (
        ("currency" = 'UZS' AND "rateId" IS NULL AND "rateOverrideReason" IS NULL) OR
        ("currency" = 'USD' AND "rateId" IS NOT NULL AND "rateOverrideReason" IS NULL) OR
        ("currency" = 'USD' AND "rateId" IS NULL AND "rateOverrideReason" IS NOT NULL)
    ),
    CONSTRAINT "Purchase_cancellation_consistency_check" CHECK (
        ("cancelledAt" IS NULL AND "cancellationReason" IS NULL AND "cancelledById" IS NULL) OR
        ("cancelledAt" IS NOT NULL AND "cancellationReason" IS NOT NULL AND "cancelledById" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "PurchaseItem" (
    "id" UUID NOT NULL,
    "purchaseId" UUID NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "materialId" UUID NOT NULL,
    "materialNameSnapshot" TEXT NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "unitPrice" DECIMAL(24,8) NOT NULL,
    "lineAmount" DECIMAL(24,2) NOT NULL,
    "lineAmountUzs" DECIMAL(24,2) NOT NULL,

    CONSTRAINT "PurchaseItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PurchaseItem_quantity_positive_check" CHECK ("quantity" > 0),
    CONSTRAINT "PurchaseItem_unitPrice_positive_check" CHECK ("unitPrice" > 0),
    CONSTRAINT "PurchaseItem_lineAmount_positive_check" CHECK ("lineAmount" > 0),
    CONSTRAINT "PurchaseItem_lineAmountUzs_positive_check" CHECK ("lineAmountUzs" > 0)
);

-- CreateTable
CREATE TABLE "SupplierPayment" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "purpose" "SupplierPaymentPurpose" NOT NULL,
    "currency" "Currency" NOT NULL,
    "amount" DECIMAL(24,2) NOT NULL,
    "exchangeRate" DECIMAL(24,8) NOT NULL,
    "amountUzs" DECIMAL(24,2) NOT NULL,
    "rateSource" "RateSource" NOT NULL DEFAULT 'MANUAL',
    "rateId" UUID,
    "rateOverrideReason" TEXT,
    "comment" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierPayment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SupplierPayment_amount_positive_check" CHECK ("amount" > 0),
    CONSTRAINT "SupplierPayment_amountUzs_positive_check" CHECK ("amountUzs" > 0),
    CONSTRAINT "SupplierPayment_currency_exchangeRate_check" CHECK (
        ("currency" = 'UZS' AND "exchangeRate" = 1) OR
        ("currency" = 'USD' AND "exchangeRate" > 0)
    ),
    CONSTRAINT "SupplierPayment_rate_consistency_check" CHECK (
        ("currency" = 'UZS' AND "rateId" IS NULL AND "rateOverrideReason" IS NULL) OR
        ("currency" = 'USD' AND "rateId" IS NOT NULL AND "rateOverrideReason" IS NULL) OR
        ("currency" = 'USD' AND "rateId" IS NULL AND "rateOverrideReason" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "SupplierAdvance" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "fundingPaymentId" UUID NOT NULL,
    "currency" "Currency" NOT NULL,
    "fundedAmount" DECIMAL(24,2) NOT NULL,
    "fundedAmountUzs" DECIMAL(24,2) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierAdvance_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SupplierAdvance_fundedAmount_positive_check" CHECK ("fundedAmount" > 0),
    CONSTRAINT "SupplierAdvance_fundedAmountUzs_positive_check" CHECK ("fundedAmountUzs" > 0)
);

-- CreateTable
CREATE TABLE "SettlementAllocation" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "purchaseId" UUID NOT NULL,
    "fundingPaymentId" UUID,
    "advanceId" UUID,
    "settlementCurrency" "Currency" NOT NULL,
    "settlementAmount" DECIMAL(24,2) NOT NULL,
    "settlementValueUzs" DECIMAL(24,2) NOT NULL,
    "debtCurrency" "Currency" NOT NULL,
    "settlementExchangeRate" DECIMAL(24,8),
    "debtAmountSettled" DECIMAL(24,2) NOT NULL,
    "exchangeDifferenceUzs" DECIMAL(24,2) NOT NULL,
    "effect" "SettlementEffect" NOT NULL DEFAULT 'APPLY',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversalOfId" UUID,

    CONSTRAINT "SettlementAllocation_pkey" PRIMARY KEY ("id"),
    -- Exactly one funding source (transaction-design.md §5 / this
    -- migration's own model doc comment).
    CONSTRAINT "SettlementAllocation_funding_source_xor_check" CHECK (
        ("fundingPaymentId" IS NOT NULL AND "advanceId" IS NULL) OR
        ("fundingPaymentId" IS NULL AND "advanceId" IS NOT NULL)
    ),
    CONSTRAINT "SettlementAllocation_settlementAmount_positive_check" CHECK ("settlementAmount" > 0),
    CONSTRAINT "SettlementAllocation_settlementValueUzs_positive_check" CHECK ("settlementValueUzs" > 0),
    CONSTRAINT "SettlementAllocation_debtAmountSettled_positive_check" CHECK ("debtAmountSettled" > 0),
    -- transaction-design.md §5's exact database-enforcement line: a rate is
    -- required (and positive) only in case 3 (settlementCurrency !=
    -- debtCurrency AND debtCurrency != 'UZS'); every other case must NOT
    -- carry one, since it would otherwise look like a caller-confirmed
    -- override that was never actually asked for.
    CONSTRAINT "SettlementAllocation_settlementExchangeRate_check" CHECK (
        ("settlementExchangeRate" IS NULL) = ("debtCurrency" = 'UZS' OR "debtCurrency" = "settlementCurrency")
    ),
    CONSTRAINT "SettlementAllocation_settlementExchangeRate_positive_check" CHECK (
        "settlementExchangeRate" IS NULL OR "settlementExchangeRate" > 0
    ),
    -- Defense in depth: an allocation cannot be its own reversal.
    CONSTRAINT "SettlementAllocation_reversal_not_self_check" CHECK (
        "reversalOfId" IS NULL OR "reversalOfId" <> "id"
    )
);

-- CreateIndex
CREATE INDEX "Supplier_projectId_isActive_name_idx" ON "Supplier"("projectId", "isActive", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_projectId_id_key" ON "Supplier"("projectId", "id");

-- CreateIndex
CREATE INDEX "Purchase_projectId_supplierId_idx" ON "Purchase"("projectId", "supplierId");

-- CreateIndex
CREATE INDEX "Purchase_projectId_warehouseId_idx" ON "Purchase"("projectId", "warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_operationId_key" ON "Purchase"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_projectId_id_key" ON "Purchase"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_projectId_supplierId_id_key" ON "Purchase"("projectId", "supplierId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseItem_purchaseId_lineNumber_key" ON "PurchaseItem"("purchaseId", "lineNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseItem_purchaseId_materialId_key" ON "PurchaseItem"("purchaseId", "materialId");

-- CreateIndex
CREATE INDEX "SupplierPayment_projectId_supplierId_currency_idx" ON "SupplierPayment"("projectId", "supplierId", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPayment_operationId_key" ON "SupplierPayment"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPayment_projectId_id_key" ON "SupplierPayment"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPayment_projectId_supplierId_id_key" ON "SupplierPayment"("projectId", "supplierId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierAdvance_fundingPaymentId_key" ON "SupplierAdvance"("fundingPaymentId");

-- CreateIndex
CREATE INDEX "SupplierAdvance_projectId_supplierId_currency_idx" ON "SupplierAdvance"("projectId", "supplierId", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierAdvance_projectId_id_key" ON "SupplierAdvance"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierAdvance_projectId_supplierId_id_key" ON "SupplierAdvance"("projectId", "supplierId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierAdvance_projectId_fundingPaymentId_key" ON "SupplierAdvance"("projectId", "fundingPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementAllocation_reversalOfId_key" ON "SettlementAllocation"("reversalOfId");

-- CreateIndex
CREATE INDEX "SettlementAllocation_projectId_purchaseId_idx" ON "SettlementAllocation"("projectId", "purchaseId");

-- CreateIndex
CREATE INDEX "SettlementAllocation_projectId_advanceId_idx" ON "SettlementAllocation"("projectId", "advanceId");

-- CreateIndex
CREATE INDEX "SettlementAllocation_projectId_fundingPaymentId_idx" ON "SettlementAllocation"("projectId", "fundingPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialTransaction_supplierPaymentId_key" ON "FinancialTransaction"("supplierPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialTransaction_projectId_supplierPaymentId_key" ON "FinancialTransaction"("projectId", "supplierPaymentId");

-- AddForeignKey
ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_projectId_supplierPaymentId_fkey" FOREIGN KEY ("projectId", "supplierPaymentId") REFERENCES "SupplierPayment"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_projectId_operationId_fkey" FOREIGN KEY ("projectId", "operationId") REFERENCES "PostedOperation"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_projectId_supplierId_fkey" FOREIGN KEY ("projectId", "supplierId") REFERENCES "Supplier"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_projectId_warehouseId_fkey" FOREIGN KEY ("projectId", "warehouseId") REFERENCES "Warehouse"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_projectId_rateId_fkey" FOREIGN KEY ("projectId", "rateId") REFERENCES "CurrencyRate"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_projectId_operationId_fkey" FOREIGN KEY ("projectId", "operationId") REFERENCES "PostedOperation"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_projectId_supplierId_fkey" FOREIGN KEY ("projectId", "supplierId") REFERENCES "Supplier"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_projectId_rateId_fkey" FOREIGN KEY ("projectId", "rateId") REFERENCES "CurrencyRate"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierAdvance" ADD CONSTRAINT "SupplierAdvance_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierAdvance" ADD CONSTRAINT "SupplierAdvance_projectId_supplierId_fkey" FOREIGN KEY ("projectId", "supplierId") REFERENCES "Supplier"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierAdvance" ADD CONSTRAINT "SupplierAdvance_projectId_fundingPaymentId_fkey" FOREIGN KEY ("projectId", "fundingPaymentId") REFERENCES "SupplierPayment"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SettlementAllocation" ADD CONSTRAINT "SettlementAllocation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SettlementAllocation" ADD CONSTRAINT "SettlementAllocation_projectId_operationId_fkey" FOREIGN KEY ("projectId", "operationId") REFERENCES "PostedOperation"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SettlementAllocation" ADD CONSTRAINT "SettlementAllocation_projectId_supplierId_fkey" FOREIGN KEY ("projectId", "supplierId") REFERENCES "Supplier"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SettlementAllocation" ADD CONSTRAINT "SettlementAllocation_projectId_supplierId_purchaseId_fkey" FOREIGN KEY ("projectId", "supplierId", "purchaseId") REFERENCES "Purchase"("projectId", "supplierId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SettlementAllocation" ADD CONSTRAINT "SettlementAllocation_projectId_supplierId_fundingPaymentId_fkey" FOREIGN KEY ("projectId", "supplierId", "fundingPaymentId") REFERENCES "SupplierPayment"("projectId", "supplierId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SettlementAllocation" ADD CONSTRAINT "SettlementAllocation_projectId_supplierId_advanceId_fkey" FOREIGN KEY ("projectId", "supplierId", "advanceId") REFERENCES "SupplierAdvance"("projectId", "supplierId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SettlementAllocation" ADD CONSTRAINT "SettlementAllocation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SettlementAllocation" ADD CONSTRAINT "SettlementAllocation_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "SettlementAllocation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written immutability triggers (Prisma has no trigger support; see
-- docs/adr/0008-manual-sql-check-constraints.md). Purchase mirrors
-- FinancialTransaction's exact shape: `comment` stays editable at any time
-- (docs/backend-architecture.md's business-rules table — "comments and
-- attachments may be edited"), the three cancellation fields may be set
-- together exactly once, and every other posted field is immutable from
-- creation. Phase 6 builds no purchase-creation/cancellation workflow
-- itself, but the trigger is schema-level infrastructure, not tied to any
-- particular caller — Phase 7 posts into a table whose invariants are
-- already proven correct.
CREATE FUNCTION purchase_prevent_illegal_update() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."cancelledAt" IS NOT NULL AND (
    NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt"
    OR NEW."cancellationReason" IS DISTINCT FROM OLD."cancellationReason"
    OR NEW."cancelledById" IS DISTINCT FROM OLD."cancelledById"
  ) THEN
    RAISE EXCEPTION 'Purchase % cancellation is final and cannot be changed', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD."projectId" IS DISTINCT FROM NEW."projectId"
    OR OLD."operationId" IS DISTINCT FROM NEW."operationId"
    OR OLD."supplierId" IS DISTINCT FROM NEW."supplierId"
    OR OLD."supplierNameSnapshot" IS DISTINCT FROM NEW."supplierNameSnapshot"
    OR OLD."warehouseId" IS DISTINCT FROM NEW."warehouseId"
    OR OLD."warehouseNameSnapshot" IS DISTINCT FROM NEW."warehouseNameSnapshot"
    OR OLD."currency" IS DISTINCT FROM NEW."currency"
    OR OLD."exchangeRate" IS DISTINCT FROM NEW."exchangeRate"
    OR OLD."rateSource" IS DISTINCT FROM NEW."rateSource"
    OR OLD."rateId" IS DISTINCT FROM NEW."rateId"
    OR OLD."rateOverrideReason" IS DISTINCT FROM NEW."rateOverrideReason"
    OR OLD."totalAmount" IS DISTINCT FROM NEW."totalAmount"
    OR OLD."totalAmountUzs" IS DISTINCT FROM NEW."totalAmountUzs"
    OR OLD."invoiceNumber" IS DISTINCT FROM NEW."invoiceNumber"
    OR OLD."occurredAt" IS DISTINCT FROM NEW."occurredAt"
    OR OLD."createdById" IS DISTINCT FROM NEW."createdById"
    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
  THEN
    RAISE EXCEPTION 'Purchase % posted fields are immutable', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER purchase_prevent_illegal_update
  BEFORE UPDATE ON "Purchase"
  FOR EACH ROW
  EXECUTE FUNCTION purchase_prevent_illegal_update();

-- PurchaseItem: fully append-only (no comment, no cancellation concept of
-- its own — correction happens by cancelling the whole owning Purchase).
CREATE FUNCTION purchase_item_prevent_update() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'PurchaseItem % is append-only and cannot be modified', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER purchase_item_prevent_update
  BEFORE UPDATE ON "PurchaseItem"
  FOR EACH ROW
  EXECUTE FUNCTION purchase_item_prevent_update();

-- SupplierPayment: `comment` stays editable (same rationale as Purchase);
-- everything else immutable. No cancellation fields of its own — a
-- supplier payment's "cancelled" state is entirely reflected by its linked
-- FinancialTransaction.cancelledAt (docs/backend-data-model.md: "at most
-- one financial row per supplier payment").
CREATE FUNCTION supplier_payment_prevent_illegal_update() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."projectId" IS DISTINCT FROM NEW."projectId"
    OR OLD."operationId" IS DISTINCT FROM NEW."operationId"
    OR OLD."supplierId" IS DISTINCT FROM NEW."supplierId"
    OR OLD."purpose" IS DISTINCT FROM NEW."purpose"
    OR OLD."currency" IS DISTINCT FROM NEW."currency"
    OR OLD."amount" IS DISTINCT FROM NEW."amount"
    OR OLD."exchangeRate" IS DISTINCT FROM NEW."exchangeRate"
    OR OLD."amountUzs" IS DISTINCT FROM NEW."amountUzs"
    OR OLD."rateSource" IS DISTINCT FROM NEW."rateSource"
    OR OLD."rateId" IS DISTINCT FROM NEW."rateId"
    OR OLD."rateOverrideReason" IS DISTINCT FROM NEW."rateOverrideReason"
    OR OLD."createdById" IS DISTINCT FROM NEW."createdById"
    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
  THEN
    RAISE EXCEPTION 'SupplierPayment % posted fields are immutable', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER supplier_payment_prevent_illegal_update
  BEFORE UPDATE ON "SupplierPayment"
  FOR EACH ROW
  EXECUTE FUNCTION supplier_payment_prevent_illegal_update();

-- SupplierAdvance: fully append-only — the funding snapshot never changes
-- (this phase's §6.4).
CREATE FUNCTION supplier_advance_prevent_update() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'SupplierAdvance % is append-only and cannot be modified', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER supplier_advance_prevent_update
  BEFORE UPDATE ON "SupplierAdvance"
  FOR EACH ROW
  EXECUTE FUNCTION supplier_advance_prevent_update();

-- SettlementAllocation: fully append-only — a correction is a new REVERSE
-- allocation, never an edit (docs/adr/0004-dependency-ordered-cancellation.md).
CREATE FUNCTION settlement_allocation_prevent_update() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'SettlementAllocation % is append-only and cannot be modified', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER settlement_allocation_prevent_update
  BEFORE UPDATE ON "SettlementAllocation"
  FOR EACH ROW
  EXECUTE FUNCTION settlement_allocation_prevent_update();

