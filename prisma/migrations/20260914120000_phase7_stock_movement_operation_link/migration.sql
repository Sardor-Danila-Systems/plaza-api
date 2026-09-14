
-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "operationId" UUID NOT NULL,
ADD COLUMN     "purchaseItemId" UUID;

-- CreateIndex
CREATE INDEX "StockMovement_purchaseItemId_idx" ON "StockMovement"("purchaseItemId");

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_projectId_operationId_fkey" FOREIGN KEY ("projectId", "operationId") REFERENCES "PostedOperation"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_purchaseItemId_fkey" FOREIGN KEY ("purchaseItemId") REFERENCES "PurchaseItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

