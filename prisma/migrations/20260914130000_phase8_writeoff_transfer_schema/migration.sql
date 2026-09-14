-- Phase 8 — Inventory Operations (write-off, warehouse transfer).
--
-- Generated via `prisma migrate diff --from-config-datasource --to-schema
-- prisma/schema.prisma --script` (the same non-interactive path used for
-- Phase 6/7's own schema-only migrations — `prisma migrate dev` prompts
-- interactively for a new FK/index plan and cannot complete in this
-- non-interactive session), then hand-edited to add the CHECK constraints
-- and immutability triggers Prisma's schema language cannot express
-- (docs/adr/0008-manual-sql-check-constraints.md) — the same discipline as
-- every prior migration in this project.

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "transferId" UUID,
ADD COLUMN     "writeOffId" UUID;

-- CreateTable
CREATE TABLE "StockWriteOff" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "warehouseNameSnapshot" TEXT NOT NULL,
    "materialId" UUID NOT NULL,
    "materialNameSnapshot" TEXT NOT NULL,
    "blockId" UUID NOT NULL,
    "floorId" UUID NOT NULL,
    "blockNameSnapshot" TEXT NOT NULL,
    "floorLabelSnapshot" TEXT NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "unitCostUzs" DECIMAL(30,8) NOT NULL,
    "totalCostUzs" DECIMAL(30,8) NOT NULL,
    "comment" TEXT,
    "occurredAt" DATE NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMPTZ(6),
    "cancellationReason" TEXT,
    "cancelledById" UUID,

    CONSTRAINT "StockWriteOff_pkey" PRIMARY KEY ("id"),
    -- Hand-added, matching Purchase's own shape.
    CONSTRAINT "StockWriteOff_quantity_positive_check" CHECK ("quantity" > 0),
    CONSTRAINT "StockWriteOff_unitCostUzs_nonnegative_check" CHECK ("unitCostUzs" >= 0),
    CONSTRAINT "StockWriteOff_totalCostUzs_nonnegative_check" CHECK ("totalCostUzs" >= 0),
    CONSTRAINT "StockWriteOff_cancellation_consistency_check" CHECK (
        ("cancelledAt" IS NULL AND "cancellationReason" IS NULL AND "cancelledById" IS NULL) OR
        ("cancelledAt" IS NOT NULL AND "cancellationReason" IS NOT NULL AND "cancelledById" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "WarehouseTransfer" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "sourceWarehouseId" UUID NOT NULL,
    "sourceWarehouseNameSnapshot" TEXT NOT NULL,
    "destinationWarehouseId" UUID NOT NULL,
    "destinationWarehouseNameSnapshot" TEXT NOT NULL,
    "materialId" UUID NOT NULL,
    "materialNameSnapshot" TEXT NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "unitCostUzs" DECIMAL(30,8) NOT NULL,
    "totalCostUzs" DECIMAL(30,8) NOT NULL,
    "comment" TEXT,
    "occurredAt" DATE NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMPTZ(6),
    "cancellationReason" TEXT,
    "cancelledById" UUID,

    CONSTRAINT "WarehouseTransfer_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WarehouseTransfer_quantity_positive_check" CHECK ("quantity" > 0),
    CONSTRAINT "WarehouseTransfer_unitCostUzs_nonnegative_check" CHECK ("unitCostUzs" >= 0),
    CONSTRAINT "WarehouseTransfer_totalCostUzs_nonnegative_check" CHECK ("totalCostUzs" >= 0),
    -- transaction-design.md §7 / invariant #13: cross-warehouse only, at the
    -- database layer too, not just the service check.
    CONSTRAINT "WarehouseTransfer_source_ne_destination_check" CHECK ("sourceWarehouseId" <> "destinationWarehouseId"),
    CONSTRAINT "WarehouseTransfer_cancellation_consistency_check" CHECK (
        ("cancelledAt" IS NULL AND "cancellationReason" IS NULL AND "cancelledById" IS NULL) OR
        ("cancelledAt" IS NOT NULL AND "cancellationReason" IS NOT NULL AND "cancelledById" IS NOT NULL)
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "StockWriteOff_operationId_key" ON "StockWriteOff"("operationId");

-- CreateIndex
CREATE INDEX "StockWriteOff_projectId_blockId_idx" ON "StockWriteOff"("projectId", "blockId");

-- CreateIndex
CREATE INDEX "StockWriteOff_projectId_floorId_idx" ON "StockWriteOff"("projectId", "floorId");

-- CreateIndex
CREATE INDEX "StockWriteOff_projectId_warehouseId_idx" ON "StockWriteOff"("projectId", "warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "StockWriteOff_projectId_id_key" ON "StockWriteOff"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WarehouseTransfer_operationId_key" ON "WarehouseTransfer"("operationId");

-- CreateIndex
CREATE INDEX "WarehouseTransfer_projectId_sourceWarehouseId_idx" ON "WarehouseTransfer"("projectId", "sourceWarehouseId");

-- CreateIndex
CREATE INDEX "WarehouseTransfer_projectId_destinationWarehouseId_idx" ON "WarehouseTransfer"("projectId", "destinationWarehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "WarehouseTransfer_projectId_id_key" ON "WarehouseTransfer"("projectId", "id");

-- CreateIndex
CREATE INDEX "StockMovement_writeOffId_idx" ON "StockMovement"("writeOffId");

-- CreateIndex
CREATE INDEX "StockMovement_transferId_idx" ON "StockMovement"("transferId");

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_projectId_writeOffId_fkey" FOREIGN KEY ("projectId", "writeOffId") REFERENCES "StockWriteOff"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_projectId_transferId_fkey" FOREIGN KEY ("projectId", "transferId") REFERENCES "WarehouseTransfer"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockWriteOff" ADD CONSTRAINT "StockWriteOff_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockWriteOff" ADD CONSTRAINT "StockWriteOff_projectId_operationId_fkey" FOREIGN KEY ("projectId", "operationId") REFERENCES "PostedOperation"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockWriteOff" ADD CONSTRAINT "StockWriteOff_projectId_warehouseId_fkey" FOREIGN KEY ("projectId", "warehouseId") REFERENCES "Warehouse"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockWriteOff" ADD CONSTRAINT "StockWriteOff_projectId_materialId_fkey" FOREIGN KEY ("projectId", "materialId") REFERENCES "Material"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockWriteOff" ADD CONSTRAINT "StockWriteOff_projectId_blockId_floorId_fkey" FOREIGN KEY ("projectId", "blockId", "floorId") REFERENCES "Floor"("projectId", "blockId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockWriteOff" ADD CONSTRAINT "StockWriteOff_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockWriteOff" ADD CONSTRAINT "StockWriteOff_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WarehouseTransfer" ADD CONSTRAINT "WarehouseTransfer_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WarehouseTransfer" ADD CONSTRAINT "WarehouseTransfer_projectId_operationId_fkey" FOREIGN KEY ("projectId", "operationId") REFERENCES "PostedOperation"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WarehouseTransfer" ADD CONSTRAINT "WarehouseTransfer_projectId_sourceWarehouseId_fkey" FOREIGN KEY ("projectId", "sourceWarehouseId") REFERENCES "Warehouse"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WarehouseTransfer" ADD CONSTRAINT "WarehouseTransfer_projectId_destinationWarehouseId_fkey" FOREIGN KEY ("projectId", "destinationWarehouseId") REFERENCES "Warehouse"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WarehouseTransfer" ADD CONSTRAINT "WarehouseTransfer_projectId_materialId_fkey" FOREIGN KEY ("projectId", "materialId") REFERENCES "Material"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WarehouseTransfer" ADD CONSTRAINT "WarehouseTransfer_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WarehouseTransfer" ADD CONSTRAINT "WarehouseTransfer_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Immutability triggers (docs/adr/0008). `StockMovement`'s own append-only
-- trigger (Phase 5) already denies ANY update unconditionally, so the two
-- new nullable FK columns on it need no new trigger. `StockWriteOff` and
-- `WarehouseTransfer` follow exactly Purchase's own shape: `comment` stays
-- editable at any time, the three cancellation fields may be set together
-- exactly once, and every other posted field is immutable from creation.

CREATE FUNCTION stock_write_off_prevent_illegal_update() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."cancelledAt" IS NOT NULL AND (
    NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt"
    OR NEW."cancellationReason" IS DISTINCT FROM OLD."cancellationReason"
    OR NEW."cancelledById" IS DISTINCT FROM OLD."cancelledById"
  ) THEN
    RAISE EXCEPTION 'StockWriteOff % cancellation is final and cannot be changed', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD."projectId" IS DISTINCT FROM NEW."projectId"
    OR OLD."operationId" IS DISTINCT FROM NEW."operationId"
    OR OLD."warehouseId" IS DISTINCT FROM NEW."warehouseId"
    OR OLD."warehouseNameSnapshot" IS DISTINCT FROM NEW."warehouseNameSnapshot"
    OR OLD."materialId" IS DISTINCT FROM NEW."materialId"
    OR OLD."materialNameSnapshot" IS DISTINCT FROM NEW."materialNameSnapshot"
    OR OLD."blockId" IS DISTINCT FROM NEW."blockId"
    OR OLD."floorId" IS DISTINCT FROM NEW."floorId"
    OR OLD."blockNameSnapshot" IS DISTINCT FROM NEW."blockNameSnapshot"
    OR OLD."floorLabelSnapshot" IS DISTINCT FROM NEW."floorLabelSnapshot"
    OR OLD."quantity" IS DISTINCT FROM NEW."quantity"
    OR OLD."unitCostUzs" IS DISTINCT FROM NEW."unitCostUzs"
    OR OLD."totalCostUzs" IS DISTINCT FROM NEW."totalCostUzs"
    OR OLD."occurredAt" IS DISTINCT FROM NEW."occurredAt"
    OR OLD."createdById" IS DISTINCT FROM NEW."createdById"
    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
  THEN
    RAISE EXCEPTION 'StockWriteOff % posted fields are immutable', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_write_off_prevent_illegal_update
  BEFORE UPDATE ON "StockWriteOff"
  FOR EACH ROW
  EXECUTE FUNCTION stock_write_off_prevent_illegal_update();

CREATE FUNCTION warehouse_transfer_prevent_illegal_update() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."cancelledAt" IS NOT NULL AND (
    NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt"
    OR NEW."cancellationReason" IS DISTINCT FROM OLD."cancellationReason"
    OR NEW."cancelledById" IS DISTINCT FROM OLD."cancelledById"
  ) THEN
    RAISE EXCEPTION 'WarehouseTransfer % cancellation is final and cannot be changed', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD."projectId" IS DISTINCT FROM NEW."projectId"
    OR OLD."operationId" IS DISTINCT FROM NEW."operationId"
    OR OLD."sourceWarehouseId" IS DISTINCT FROM NEW."sourceWarehouseId"
    OR OLD."sourceWarehouseNameSnapshot" IS DISTINCT FROM NEW."sourceWarehouseNameSnapshot"
    OR OLD."destinationWarehouseId" IS DISTINCT FROM NEW."destinationWarehouseId"
    OR OLD."destinationWarehouseNameSnapshot" IS DISTINCT FROM NEW."destinationWarehouseNameSnapshot"
    OR OLD."materialId" IS DISTINCT FROM NEW."materialId"
    OR OLD."materialNameSnapshot" IS DISTINCT FROM NEW."materialNameSnapshot"
    OR OLD."quantity" IS DISTINCT FROM NEW."quantity"
    OR OLD."unitCostUzs" IS DISTINCT FROM NEW."unitCostUzs"
    OR OLD."totalCostUzs" IS DISTINCT FROM NEW."totalCostUzs"
    OR OLD."occurredAt" IS DISTINCT FROM NEW."occurredAt"
    OR OLD."createdById" IS DISTINCT FROM NEW."createdById"
    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
  THEN
    RAISE EXCEPTION 'WarehouseTransfer % posted fields are immutable', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER warehouse_transfer_prevent_illegal_update
  BEFORE UPDATE ON "WarehouseTransfer"
  FOR EACH ROW
  EXECUTE FUNCTION warehouse_transfer_prevent_illegal_update();
