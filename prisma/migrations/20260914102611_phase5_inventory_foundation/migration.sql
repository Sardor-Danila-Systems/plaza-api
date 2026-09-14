-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('OPENING_RECEIPT', 'PURCHASE_RECEIPT', 'WRITE_OFF', 'TRANSFER_OUT', 'TRANSFER_IN', 'REVERSAL');

-- CreateTable
CREATE TABLE "Unit" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialCategory" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "MaterialCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Warehouse" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "comment" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Material" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "categoryId" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "minimumStock" DECIMAL(24,6),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Material_pkey" PRIMARY KEY ("id"),
    -- Hand-added: Prisma's schema language cannot express a nullable-but-
    -- bounded-when-present CHECK (docs/adr/0008-manual-sql-check-
    -- constraints.md). `minimumStock` is optional (NULL disables the
    -- low-stock warning entirely, per docs/backend-architecture.md §2) but
    -- when present must be a non-negative threshold.
    CONSTRAINT "Material_minimumStock_nonnegative_check" CHECK (
        "minimumStock" IS NULL OR "minimumStock" >= 0
    )
);

-- CreateTable
CREATE TABLE "InventoryBalance" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "materialId" UUID NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "valueUzs" DECIMAL(30,8) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "InventoryBalance_pkey" PRIMARY KEY ("id"),
    -- Hand-added: Prisma's schema language cannot express cross-column
    -- conditional CHECKs (docs/adr/0008-manual-sql-check-constraints.md).
    -- Negative inventory is forbidden outright
    -- (docs/backend-architecture.md §2).
    CONSTRAINT "InventoryBalance_quantity_nonnegative_check" CHECK ("quantity" >= 0),
    CONSTRAINT "InventoryBalance_valueUzs_nonnegative_check" CHECK ("valueUzs" >= 0),
    -- The zero-quantity invariant this phase's own instructions require
    -- (§16): "quantity = 0 => valueUzs = 0" — one-directional, matching the
    -- literal requirement exactly (a positive quantity carrying zero value
    -- is not itself forbidden here; MVP simply never produces that state
    -- since every receipt has a cost). A future write-off/transfer workflow
    -- must set both to exactly zero together on full depletion, never rely
    -- on subtraction to land there (the full-depletion rule, §13).
    CONSTRAINT "InventoryBalance_zero_quantity_zero_value_check" CHECK (
        "quantity" > 0 OR "valueUzs" = 0
    )
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "materialId" UUID NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "direction" "TransactionDirection" NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "unitCostUzs" DECIMAL(30,8) NOT NULL,
    "totalCostUzs" DECIMAL(30,8) NOT NULL,
    "occurredAt" DATE NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id"),
    -- Hand-added: Prisma's schema language cannot express these
    -- (docs/adr/0008-manual-sql-check-constraints.md). `quantity` is always
    -- a strictly positive magnitude (this phase's §11 sign convention —
    -- direction, not sign, carries in/out semantics); costs are never
    -- negative (a zero cost, e.g. a genuinely free opening receipt, is not
    -- itself forbidden here).
    CONSTRAINT "StockMovement_quantity_positive_check" CHECK ("quantity" > 0),
    CONSTRAINT "StockMovement_unitCostUzs_nonnegative_check" CHECK ("unitCostUzs" >= 0),
    CONSTRAINT "StockMovement_totalCostUzs_nonnegative_check" CHECK ("totalCostUzs" >= 0)
);

-- CreateIndex
CREATE INDEX "Unit_projectId_isActive_idx" ON "Unit"("projectId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Unit_projectId_symbol_key" ON "Unit"("projectId", "symbol");

-- CreateIndex
CREATE UNIQUE INDEX "Unit_projectId_id_key" ON "Unit"("projectId", "id");

-- CreateIndex
CREATE INDEX "MaterialCategory_projectId_isActive_idx" ON "MaterialCategory"("projectId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialCategory_projectId_name_key" ON "MaterialCategory"("projectId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialCategory_projectId_id_key" ON "MaterialCategory"("projectId", "id");

-- CreateIndex
CREATE INDEX "Warehouse_projectId_isActive_idx" ON "Warehouse"("projectId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Warehouse_projectId_code_key" ON "Warehouse"("projectId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Warehouse_projectId_id_key" ON "Warehouse"("projectId", "id");

-- CreateIndex
CREATE INDEX "Material_projectId_isActive_name_idx" ON "Material"("projectId", "isActive", "name");

-- CreateIndex
CREATE INDEX "Material_projectId_categoryId_idx" ON "Material"("projectId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Material_projectId_code_key" ON "Material"("projectId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Material_projectId_id_key" ON "Material"("projectId", "id");

-- CreateIndex
CREATE INDEX "InventoryBalance_projectId_warehouseId_idx" ON "InventoryBalance"("projectId", "warehouseId");

-- CreateIndex
CREATE INDEX "InventoryBalance_projectId_materialId_idx" ON "InventoryBalance"("projectId", "materialId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryBalance_warehouseId_materialId_key" ON "InventoryBalance"("warehouseId", "materialId");

-- CreateIndex
CREATE INDEX "StockMovement_projectId_occurredAt_idx" ON "StockMovement"("projectId", "occurredAt");

-- CreateIndex
CREATE INDEX "StockMovement_warehouseId_materialId_occurredAt_idx" ON "StockMovement"("warehouseId", "materialId", "occurredAt");

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaterialCategory" ADD CONSTRAINT "MaterialCategory_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Warehouse" ADD CONSTRAINT "Warehouse_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Material" ADD CONSTRAINT "Material_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Material" ADD CONSTRAINT "Material_projectId_categoryId_fkey" FOREIGN KEY ("projectId", "categoryId") REFERENCES "MaterialCategory"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Material" ADD CONSTRAINT "Material_projectId_unitId_fkey" FOREIGN KEY ("projectId", "unitId") REFERENCES "Unit"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_projectId_warehouseId_fkey" FOREIGN KEY ("projectId", "warehouseId") REFERENCES "Warehouse"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_projectId_materialId_fkey" FOREIGN KEY ("projectId", "materialId") REFERENCES "Material"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_projectId_warehouseId_fkey" FOREIGN KEY ("projectId", "warehouseId") REFERENCES "Warehouse"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_projectId_materialId_fkey" FOREIGN KEY ("projectId", "materialId") REFERENCES "Material"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (Prisma's schema language has no trigger support, see
-- docs/adr/0008-manual-sql-check-constraints.md's established pattern):
-- StockMovement is the immutable historical ledger (this phase's §10 — "No
-- PATCH... No DELETE... Later cancellation/reversal will create
-- compensating movement(s), not rewrite history"). Unlike
-- FinancialTransaction (which allows a `comment` edit) or PostedOperation
-- (which allows a one-time cancellation write), StockMovement has neither
-- concept yet — it is fully append-only, the same posture as CurrencyRate
-- and AuditLog.
CREATE FUNCTION stock_movement_prevent_update() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'StockMovement % is append-only and cannot be modified', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_movement_prevent_update
  BEFORE UPDATE ON "StockMovement"
  FOR EACH ROW
  EXECUTE FUNCTION stock_movement_prevent_update();
