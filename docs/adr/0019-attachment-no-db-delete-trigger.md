---
status: accepted
---

# A LINKED Attachment's deletion protection lives in application code, not a DB trigger

Phase 9's first `Attachment` migration added `attachment_prevent_delete_when_linked`, a
`BEFORE DELETE` trigger unconditionally rejecting deletion of any `LINKED` row —
intended as the same "database constraints are final protection, not service validation
alone" discipline every other historical table in this schema follows.

It was wrong, and a second migration
(`20260915093000_phase9_attachments_drop_delete_trigger`) removed it the same phase,
before any release. The trigger blocked ANY delete of a `LINKED` row unconditionally —
including the dependency-ordered raw deletes this project's own test fixtures (and any
future admin/data-migration tooling) legitimately perform during cleanup. Every other
"immutable" table in this schema (`StockMovement`, `PurchaseItem`, `SettlementAllocation`,
`SupplierAdvance`, ...) uses the SAME shape everywhere else: a `BEFORE UPDATE` trigger
blocks editing a posted row, but nothing blocks a raw `DELETE` — protection against
*accidental production deletion* comes from there being no delete endpoint in the API
at all, backed by `RESTRICT` foreign keys (so deleting a row still referenced elsewhere
fails structurally), not from an unconditional trigger. `Attachment`'s original delete
trigger was the only place in the whole schema that deviated from this, and it deviated
by accident, not by a considered choice to make attachments stricter than everything
else.

**Decision:** `AttachmentsService.deleteOrphan` remains the only application code path
that can ever delete an `Attachment` row, and it already rejects a `LINKED` one with
`409 ATTACHMENT_LINKED` — this is the same protection shape (application-layer-only,
no delete endpoint for the protected state) as every other historical table already
uses. No database trigger blocks the delete itself; `RESTRICT` foreign keys still
apply everywhere they did before (a `Purchase`/`FinancialTransaction`/`SupplierPayment`
still cannot be deleted while an `Attachment` references it, in either direction).

**Why this was caught immediately rather than shipped:** e2e test cleanup
(`deleteTestProject`) legitimately needs to delete every row a test created, LINKED
attachments included, in one dependency-ordered pass — the same pattern already used
for every other historical table's own test cleanup. Running that cleanup against a
project containing a LINKED attachment failed immediately with the trigger's own
rejection message, surfacing the inconsistency before Phase 9 even finished, not later
in Phase 12 or after release.
