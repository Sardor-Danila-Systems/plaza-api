-- Phase 12 hardening: Analytics/Reports (Phases 10-11) filter `Purchase`
-- and `StockWriteOff` by `(projectId, occurredAt)` (period windows, "as of
-- `to`" reconstruction, XLSX exports) — neither table had a supporting
-- index for that access pattern (each had per-relation indexes like
-- `(projectId, supplierId)` / `(projectId, blockId)`, but nothing on the
-- date column itself), so every one of those queries fell back to a full
-- table scan filtered in-database by `occurredAt` without index support.
-- Purely additive; matches the exact `(projectId, occurredAt)` shape
-- already used by `FinancialTransaction`/`StockMovement`.
CREATE INDEX "Purchase_projectId_occurredAt_idx" ON "Purchase"("projectId", "occurredAt");

CREATE INDEX "StockWriteOff_projectId_occurredAt_idx" ON "StockWriteOff"("projectId", "occurredAt");
