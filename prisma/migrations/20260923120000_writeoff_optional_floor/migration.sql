-- Material is often consumed by a building block as a whole (site-wide
-- pours, façade and roofing work) rather than by one level. Forcing those
-- write-offs onto an arbitrary floor only falsified the per-floor
-- analytics, so `floorId` becomes optional and a NULL floor means exactly
-- "this block, no single floor".
ALTER TABLE "StockWriteOff" ALTER COLUMN "floorId" DROP NOT NULL;
ALTER TABLE "StockWriteOff" ALTER COLUMN "floorLabelSnapshot" DROP NOT NULL;

-- The existing (projectId, blockId, floorId) -> Floor FK is MATCH SIMPLE,
-- so it stops being enforced the moment floorId is NULL. This second FK
-- keeps the block itself verified in that case — a block-level write-off
-- can still never name a block outside its own project.
ALTER TABLE "StockWriteOff"
    ADD CONSTRAINT "StockWriteOff_projectId_blockId_fkey"
    FOREIGN KEY ("projectId", "blockId") REFERENCES "BuildingBlock"("projectId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written CHECK per ADR 0008: the floor id and its display snapshot
-- are always written together or not at all, so no row can claim a floor
-- label without a floor (or the reverse).
ALTER TABLE "StockWriteOff"
    ADD CONSTRAINT "StockWriteOff_floor_snapshot_consistency_check"
    CHECK (("floorId" IS NULL) = ("floorLabelSnapshot" IS NULL));
