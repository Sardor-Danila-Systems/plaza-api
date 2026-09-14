---
status: accepted
---

# Cancellation is a dependency-ordered reversal, never a free edit or delete

A posted purchase, write-off, transfer, or financial transaction can never be hard-deleted or have
its amount/currency/quantity/date edited in place, because later operations (a subsequent purchase
that changed the weighted average, a later write-off that consumed stock this operation
contributed to) may already depend on its recorded effect. Naively subtracting an old purchase's
quantity/value from current inventory is mathematically wrong once a later purchase has changed
the average cost. We instead require that cancellation only succeeds when the operation being
cancelled is still the "effective head" of every balance/ledger it touched — i.e. nothing later
still depends on it — and reject with `409` (`PURCHASE_HAS_DEPENDENT_MOVEMENTS` /
`CANCELLATION_HAS_DEPENDENCIES`) otherwise, requiring the caller to reverse the dependent
operations first (or use a correction workflow) rather than offering a "force cancel" that would
silently corrupt history. This trades convenience (an old mistake sometimes can't be cancelled
until its dependents are unwound) for the guarantee that every cancellation that _is_ allowed is
exactly and provably correct.
