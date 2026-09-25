-- Suppliers carry their taxpayer id (ИНН/СТИР) so an invoice can be matched
-- to the legal entity it was issued by. Text, not a number: leading zeros
-- are significant and nothing ever does arithmetic with it.
--
-- Nullable and not unique on purpose — every existing supplier predates the
-- field, and the same entity can legitimately appear twice while records
-- are being cleaned up. The nine-digit shape is enforced by the DTO rather
-- than a CHECK so that data imported outside the API (a migration from a
-- spreadsheet, say) is never rejected at the storage layer.
ALTER TABLE "Supplier" ADD COLUMN "taxId" TEXT;

-- Supports the suppliers list's search, which matches a taxpayer id
-- exactly as often as it matches a name.
CREATE INDEX "Supplier_projectId_taxId_idx" ON "Supplier"("projectId", "taxId");
