-- Correction: the previous migration's `attachment_prevent_delete_when_linked`
-- trigger blocked ANY delete of a LINKED row unconditionally, including the
-- dependency-ordered raw deletes this project's own test fixtures (and any
-- future admin/data-migration tooling) legitimately need to perform —
-- inconsistent with every other "immutable" table in this schema
-- (StockMovement, PurchaseItem, SettlementAllocation, ...), which blocks
-- only UPDATE via a trigger and relies on RESTRICT foreign keys plus "no
-- delete endpoint exists in the API" for deletion protection, not a
-- blanket DB-level delete trigger. `AttachmentsService.deleteOrphan`
-- remains the only application code path that can ever delete an
-- Attachment, and it already rejects a LINKED row itself — this migration
-- brings the DATABASE layer's posture in line with the rest of the schema
-- rather than introducing a new, inconsistent one.
DROP TRIGGER IF EXISTS attachment_prevent_delete_when_linked ON "Attachment";
DROP FUNCTION IF EXISTS attachment_prevent_delete_when_linked();
