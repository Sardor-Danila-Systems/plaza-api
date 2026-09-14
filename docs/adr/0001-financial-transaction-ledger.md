---
status: accepted
---

# Cash balance is derived from an immutable FinancialTransaction ledger

Project cash could have been a mutable `Project.balanceUzs` field incremented/decremented on
every operation, which is simpler to query but loses history and is trivially corrupted by a
missed decrement, a retried request, or a bug in one call site. We instead treat
`FinancialTransaction` as the sole source of truth: cash balance is always the signed sum of its
rows (originals plus reversals), never a separately stored number. There is no `Project.balance`
column anywhere in the schema. Corrections are posted as reversal rows, never as edits to a
balance or deletion of a row. This costs an aggregation query per balance read (mitigated later by
a materialized/read-model projection if needed) in exchange for the ledger being able to prove
itself correct by reconstruction at any time — essential for a system that will be audited.
