---
status: accepted
---

# Inventory costing uses weighted average, not FIFO/LIFO lot tracking

Construction material stock (cement, rebar, etc.) is fungible within a warehouse — there is no
business need to track which physical delivery a given bag came from. FIFO/LIFO lot tracking would
require a lot table, lot-consumption-order logic, and lot-level locking for a benefit (exact
per-lot cost recovery) the business doesn't need. We instead keep one authoritative
`(quantity, valueUzs)` pair per `(warehouse, material)` and derive the average cost by division on
read (`valueUzs / quantity`), never storing a separately mutable average column. Every write-off
snapshots its own `unitCostUzs`/`totalCostUzs` at posting time so historical consumption cost is
permanently fixed regardless of what the average becomes later. This is irreversible without a
data migration once purchases/write-offs start accumulating, and it is the reason a later
purchase's price cannot be blamed for changing an earlier write-off's recorded cost.
