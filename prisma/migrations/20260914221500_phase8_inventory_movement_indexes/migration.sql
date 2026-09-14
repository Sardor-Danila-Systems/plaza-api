-- Phase 8 query support for dependency checks and operation lookups.
CREATE INDEX "StockMovement_projectId_operationId_idx"
  ON "StockMovement"("projectId", "operationId");

CREATE INDEX "StockMovement_projectId_warehouseId_materialId_operationId_idx"
  ON "StockMovement"("projectId", "warehouseId", "materialId", "operationId");

CREATE INDEX "StockWriteOff_projectId_materialId_idx"
  ON "StockWriteOff"("projectId", "materialId");

CREATE INDEX "WarehouseTransfer_projectId_materialId_idx"
  ON "WarehouseTransfer"("projectId", "materialId");
