---
status: accepted
---

# One project-row lock serializes all mutating operations within a project for MVP

Correct concurrent handling of inventory balances, supplier advance consumption, and debt
settlement requires locking, and getting per-row lock ordering right across warehouses, materials,
and supplier ledgers simultaneously (e.g. a purchase touches all three at once) is exactly the kind
of subtly-wrong deadlock surface that is hard to get right under deadline pressure. For MVP we
instead take one `SELECT ... FOR UPDATE` on the mutating project's own `Project` row inside a
`Serializable` transaction before touching any business table, for every write (finance posting,
purchase, write-off, transfer, cancellation, supplier settlement). This makes correctness
trivially arguable (only one writer touches a project's state at a time) at the cost of
serializing unrelated writes within the same project — two managers writing off unrelated
materials in different warehouses of Avenue Plaza cannot proceed concurrently. Different projects
are fully independent and never contend with each other. If measured contention on a single busy
project becomes a real throughput problem post-launch, the documented migration path is to
introduce narrower locks (per `InventoryBalance` row, per supplier ledger) with a defined global
lock-acquisition order — not to remove locking altogether. We are deliberately not doing that now
without evidence it's needed.
