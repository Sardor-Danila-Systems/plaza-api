# Transaction, concurrency, and cancellation design

Status: Phase 0 design, 2026-09-13, revised same day to incorporate the confirmed
cross-currency settlement rule (§8 of the second specification) and to give this
material its own authoritative document as requested. **§1-3 (the locking
protocol, retry strategy, and idempotency mechanism) were implemented for real
in Phase 4** (`ProjectLockService`, `src/database/project-lock.service.ts`;
`PostedOperation`-backed idempotency in `FinancialPostingService`) and verified
against real PostgreSQL, including tests that force genuine Serializable
conflicts — see docs/phase-0-review.md §11 and
[ADR 0017](adr/0017-raw-query-serialization-error-shape.md) for what that
verification found. §4-7 (purchase/settlement/inventory algorithms) remain
design only, not implemented or tested code, pending their own phases.

This document is the authoritative _how_ for every workflow that touches money or
inventory. [backend-architecture.md](backend-architecture.md) states policy, module
boundaries, and the API surface; [backend-data-model.md](backend-data-model.md)
states the schema; this document states the exact algorithm, lock order, retry
policy, settlement arithmetic, and the invariant-by-invariant enforcement matrix
required by the specification. Where this document and a summary elsewhere disagree,
this document wins for transaction/concurrency/settlement questions — summaries
elsewhere should link here rather than restate the formulas.

## 1. Locking strategy

**Why a single project lock.** Correct concurrent handling of inventory balances,
supplier ledgers, and cash simultaneously (one purchase touches all three) requires
locking. Getting fine-grained lock ordering right across warehouses, materials, and
supplier ledgers at once is a genuine deadlock-design problem. For MVP we accept
lower write throughput within one project in exchange for trivially arguable
correctness. See [ADR 0003](adr/0003-single-project-lock-mvp.md).

**Protocol.** Every mutating workflow (finance posting/cancellation, purchase
creation/cancellation, write-off, transfer, supplier payment/advance/cancellation,
operator project-data changes):

1. Open a Prisma interactive transaction at `Serializable` isolation.
2. `SELECT id FROM "Project" WHERE id = $1 FOR UPDATE` (parameterized, fixed
   template) inside that transaction. This blocks concurrent writers to the same
   project and is acquired before any business-row read.
3. Re-validate the actor's session, role, and project assignment _inside_ the
   transaction (not from a cache or from JWT claims alone) — a concurrently
   revoked session or reassigned manager must not slip through on a stale check
   made before the lock was acquired.
4. Increment `Project.postingSequence` (a technical ordering counter, not a
   business value) so every mutation of a project is totally ordered.
5. Only then read/validate business state, compute results, and write.

**Which operations acquire it.** All of the above; read-only endpoints
(dashboards, lists, reports, analytics) never acquire it. Authentication-only
workflows (login, refresh, logout) never acquire it — no workflow holding a
user/session lock may then wait for a project lock, and no project-lock holder
waits on a session lock, which rules out that class of deadlock by construction.

**Throughput impact.** All writes to one project are serialized; different
projects are fully independent and never contend. Read endpoints are unaffected
except for the retry cost after a rare serialization failure. This is a conscious
MVP trade documented in ADR 0003, not an oversight.

**Deadlock ordering.** Because every mutating workflow acquires exactly one
project lock and nothing else before its business logic runs, and workflows never
span two projects (cross-project transfers are forbidden, see §7), there is no
multi-project lock-ordering problem to solve for MVP. Provisioning workflows that
legitimately touch two projects (e.g. reassigning a manager) acquire affected
project IDs **in sorted UUID order** before touching either project's business
state, and never acquire a user/session lock first.

**Future migration path.** If a specific project's write volume causes measured
contention (visible as retry-rate or lock-wait metrics, not guessed), narrow the
lock to `InventoryBalance` row locks (via the existing `(warehouseId, materialId)`
unique index) and a per-supplier ledger lock, with a defined global acquisition
order (e.g. always warehouse-balance locks in ascending `id` order, then supplier
lock) to avoid introducing new deadlocks. This is out of scope until contention is
measured; do not pre-optimize.

**Missing-row locking caveat.** `SELECT ... FOR UPDATE` cannot lock a row that
doesn't exist yet — the _first_ `InventoryBalance` row for a given
`(warehouseId, materialId)` has no row to lock before it's created. The project
lock is what actually serializes "first balance creation" races for MVP; the
`@@unique([warehouseId, materialId])` constraint is the final backstop if that
protocol is ever bypassed (it should never fire in normal operation).

## 2. Retry strategy

`Serializable` transactions can fail after all locks are already held, when
PostgreSQL detects a serialization anomaly (SQLSTATE `40001`) or a deadlock
(`40P01`, mapped by Prisma's PostgreSQL adapter to `P2034`). This is expected
behavior, not a bug — the whole transaction must be retried from scratch.

- **Retryable:** `P2034` and driver-confirmed `40001`/`40P01` only.
- **Not retryable:** validation errors, foreign key violations, permission
  denials, and any unique-constraint violation _other than_ the idempotency-key
  race (see §3) — these are business outcomes, not transient contention, and
  retrying them would either loop forever or mask a real bug.
- **Bound:** at most 3 attempts total, with small jittered backoff between
  attempts, inside an overall per-request deadline. Exhaustion returns `409
CONCURRENT_MODIFICATION` (marked retryable so the client may retry the whole
  HTTP request later).
- **Boundary:** the retry loop wraps the _entire_ `$transaction` callback,
  including all reads used to compute the result. Nothing is retried "halfway" —
  a retry re-runs step 3 onward of the locking protocol (§1) with fresh reads.
  No external side effect (storage upload, rate-provider HTTP call, notification)
  is ever placed inside the retried callback; anything like that is resolved
  _before_ the transaction starts and passed in as an already-known value.
- **Explicit rule for pre-transaction checks:** any authorization or entity
  existence check that gates whether a request is even attempted (e.g. "does
  this purchase exist", "is this supplier active") must be re-evaluated _inside_
  the transaction on every attempt, including retries. An early fast-path check
  performed once before the retry loop is not permitted for anything whose
  answer affects a financial or inventory decision — only for cheap, purely
  informational request shaping (e.g. 404 before even parsing a large body).

## 3. Idempotency

See [ADR 0005](adr/0005-idempotency-key-required.md) for why. Mechanism:

- Required header: `Idempotency-Key` (client-generated, opaque, ≥16 bytes of
  entropy recommended) on purchase, supplier payment, supplier advance, warehouse
  transfer, and their cancellation endpoints.
- Store `(projectId, actorId, operationKind, idempotencyKey)` unique, plus a
  canonical hash of the semantically significant request fields (decimal strings
  normalized, item order stabilized, route IDs and operation kind included,
  bearer token excluded) and the resulting operation's identity, written
  atomically with the operation's business effects in the same transaction
  (`PostedOperation` row, see backend-data-model.md).
- Same key + same hash → return the previously committed result (`200`, not a
  re-execution). Same key + different hash → `409 IDEMPOTENCY_KEY_REUSED`.
- Race handling: if two requests with the same fresh key both reach the unique
  insert, one wins and one hits the unique violation. The loser does not treat
  this as a generic error — it opens a **new** read-only transaction, looks up
  the now-existing `PostedOperation` by key, and returns that result. It never
  swallows an arbitrary unique violation as "probably idempotency."
- Posted financial/inventory idempotency keys do not expire in MVP (financial
  history is kept indefinitely, so neither is the key that produced it).

## 4. Purchase transaction algorithm

One Prisma interactive transaction, following the locking protocol in §1, executes
all of the following or none of them:

1. Resolve supplier, warehouse, every distinct material referenced by an item,
   and every referenced advance, all via project-scoped composite-FK queries
   (batched, not one query per item). Require each to be `isActive`.
2. Validate: positive quantities/prices, no duplicate material lines in one
   purchase request (MVP does not merge duplicate lines — reject them), currency
   is one purchase-wide currency, selected advances belong to this supplier and
   this project.
3. Compute each item's line total as `round2(quantity * unitPrice)` in the
   purchase currency, sum to the invoice total (never trust a client-supplied
   total), then convert once to UZS and distribute the UZS total across lines by
   largest-remainder allocation (see backend-architecture.md §4) so item UZS
   totals sum exactly to the invoice UZS total.
4. Create `Purchase` + immutable `PurchaseItem` rows.
5. For each distinct material, create one `PURCHASE_RECEIPT` `StockMovement`
   (materials never split across multiple movements for one purchase), applying
   the weighted-average receipt formula (§6) and updating `InventoryBalance` and
   its effective-movement head under the already-held project lock.
6. If advances were selected: for each, create a `SettlementAllocation`
   (`effect = APPLY`) against the purchase using the cross-currency formula in
   §5, verifying `sum(allocations for this advance) <= fundedAmount` inside this
   same transaction (re-read, not from a stale balance).
7. Compute remaining amount owed after advance allocation
   (`invoiceTotal − Σ debtAmountSettled from advances, expressed in invoice
currency`). If the caller specified a cash payment `> 0`: create one
   `SupplierPayment` (`purpose = PURCHASE_CASH`), one `SettlementAllocation`
   (`effect = APPLY`) linking it to the purchase, and exactly one
   `FinancialTransaction` (`type = PURCHASE`, direction `OUT`). A `0` cash
   payment creates **no** `FinancialTransaction` row and no `SupplierPayment` row
   (§17 of the specification — no fabricated zero-value cash entry).
8. Verify: `cash nominal + advance debtAmountSettled (in invoice currency) <=
invoiceTotal`. Unsettled remainder is the purchase's debt — there is no
   separate "debt" row to create; debt is always the derived quantity
   `purchase total − Σ effective settlement allocations` (§8 of
   backend-data-model.md's design principle: no `Supplier.debt` scalar).
9. Insert the `AuditLog` entry for the purchase creation (and for each advance
   consumption / payment, per §31 of the specification) in the same transaction.
10. Persist the `PostedOperation` idempotency record with the purchase's identity.
11. Commit. Any failure at any step — including the audit insert or a final
    invariant re-check — rolls back everything: no state where the purchase
    exists without its inventory, or inventory exists without its purchase, or
    cash/advance moved without the purchase, is ever observable.

Zero-cash, advance-only purchases (§17) follow exactly this algorithm with the
cash-payment step skipped entirely — no special-cased "fake" transaction type.

## 5. Settlement allocation: cross-currency settlement

This section supersedes the earlier draft's "same-currency only" rule per
[ADR 0006](adr/0006-cross-currency-settlement-explicit-rate.md).

**Fixed facts per operation:**

- `debtCurrency` — the purchase's own currency. Never changes.
- `settlementCurrency` — the `SupplierPayment` or `SupplierAdvance` funding
  currency. Fixed when that payment/advance was created.
- `settlementAmount` — the nominal amount, in `settlementCurrency`, allocated by
  this `SettlementAllocation` row.
- `settlementValueUzs` — `settlementAmount` converted to UZS using the
  **settlement's own already-recorded currency→UZS rate** (the rate confirmed
  when the `SupplierPayment`/`SupplierAdvance` itself was created; `1:1` if
  `settlementCurrency = UZS`). This is never a new rate.

**Computing `debtAmountSettled` (in `debtCurrency`) — exactly one of three cases
applies, and the discriminator is entirely determined by the two currencies
involved, not by caller choice:**

1. `settlementCurrency = debtCurrency` → `debtAmountSettled = settlementAmount`.
   No conversion, no rate field used at all. (Covers: USD debt paid with USD
   cash, USD advance consumed against a USD purchase, UZS-UZS.)
2. `settlementCurrency ≠ debtCurrency` **and** `debtCurrency = 'UZS'` →
   `debtAmountSettled = settlementValueUzs`. Uses the settlement's own
   already-required rate; no _new_ confirmation needed, because a foreign-currency
   payment already had to have its UZS rate confirmed to exist at all. (Covers: a
   UZS-denominated purchase paid with USD cash.)
3. `settlementCurrency ≠ debtCurrency` **and** `debtCurrency ≠ 'UZS'` →
   **requires** a new field `settlementExchangeRate`: the UZS value of one unit
   of `debtCurrency`, explicitly supplied by the caller for _this allocation_,
   positive, never defaulted from the purchase's invoice rate, the payment's own
   rate, or a live provider quote (even if `CurrencyModule` suggests one).
   `debtAmountSettled = round(settlementValueUzs / settlementExchangeRate,
debtCurrencyScale)`. Missing or non-positive rate in this case is rejected
   with `409 SETTLEMENT_RATE_REQUIRED` before any write. (Covers exactly the
   specification's worked example: USD 1,000 debt paid with UZS 12,500,000 at an
   explicitly confirmed 12,500 UZS/USD → `debtAmountSettled = 1,000` USD, debt
   fully settled.)

**`exchangeDifferenceUzs` (informational only, never affects debt/cash
arithmetic):**

```
exchangeDifferenceUzs =
  settlementValueUzs − round(debtAmountSettled × purchase.exchangeRateAtInvoice, 2)
```

where `purchase.exchangeRateAtInvoice = 1` when `debtCurrency = 'UZS'`. This is
always `0` when `debtCurrency = 'UZS'` (by construction) and captures the FX
gain/loss versus the _original invoice valuation_ in every other case — including
the same-currency/different-rate scenario (USD debt invoiced at 12,500, paid at
13,000: `debtAmountSettled = settlementAmount` exactly by case 1 above, and
`exchangeDifferenceUzs` reports the 50,000 UZS loss for analytics without ever
touching the nominal USD debt figure). This is a reporting number, never a second
ledger row and never a change to inventory cost.

**Rounding residue.** When one payment or advance is split across multiple
purchases in one operation, distribute `settlementAmount`/`settlementValueUzs`
proportionally to each target and let the _last_ allocation in that operation take
the exact residual, so the sum of allocations equals the payment/advance total
exactly — the same largest-remainder discipline used for purchase item totals.
If rounding under case 3 would push cumulative `debtAmountSettled` a cent past the
purchase's remaining debt, cap the last allocation's `debtAmountSettled` at the
exact remaining debt and let the residual show up only in
`exchangeDifferenceUzs` — debt must never go negative and no extra cash is ever
invented to make the arithmetic close.

**Database enforcement (see backend-data-model.md for the full field list):**
`CHECK (settlementExchangeRate IS NULL) = (debtCurrency = 'UZS' OR debtCurrency =
settlementCurrency)`, plus `settlementExchangeRate > 0` when present, plus
`settlementAmount > 0`, `settlementValueUzs > 0`, `debtAmountSettled > 0`. A
deferred aggregate trigger re-checks, per purchase and per funding lot,
`0 <= Σ effective debtAmountSettled <= purchase.totalAmount` (debt) and
`0 <= Σ effective settlementAmount consumed <= advance.fundedAmount` (advance) at
commit — the service-level check inside the project lock is the primary defense;
the trigger is the backstop against a bypass.

## 6. Inventory receipt and write-off formulas

**Receipt** (purchase or opening stock), with existing balance `(Q, V)`, received
quantity `q > 0`, posted receipt value `v` (its UZS-valued total, from §4/§3):

```
Q' = Q + q
V' = V + v
displayed average = V' / Q'   // derived on read, never stored
```

**Outbound movement (write-off, transfer-out), the general case** — with `q`
strictly less than current balance quantity `Q`:

```
unitCostUzs = round8(V / Q)          // unrounded division, display snapshot
costUzs     = round8(V * q / Q)      // unrounded division, authoritative for this movement
Q' = Q - q
V' = V - costUzs
```

**Outbound movement, full-depletion case** — `q = Q` exactly. This is a
_separate, explicit_ rule per §23 of the specification, not a derived consequence
of the formula above:

```
if q == Q:
    costUzs = V              // exact stored value, not round8(V * q / Q)
    Q' = 0
    V' = 0                   // hardcoded, never computed by subtraction
    averageCostUzs = 0       // hardcoded
```

This is deliberately not "apply the general formula and trust it lands on zero."
`round8(V * Q / Q)` is mathematically a no-op but is **not** guaranteed to
re-produce `V` to the last stored digit through Decimal division depending on
`V`/`Q`'s exact digits, which could leave `valueUzs` at e.g. `0.00000001`
instead of exactly `0` — silently violating the `quantity = 0 ⇒ value = 0`
invariant that full depletion is specifically supposed to satisfy. The service
implementation must branch on `q == Q` _before_ computing `costUzs`, not rely on
the general formula's output happening to equal `V`.

`StockMovement` always stores the historical `quantity`, `unitCostUzs` (display),
and `totalCostUzs` (authoritative) it was posted with, in both cases — future
purchases changing the current average never rewrite a posted movement.

## 7. Warehouse transfer

A transfer is two `StockMovement` rows (`TRANSFER_OUT` at the source,
`TRANSFER_IN` at the destination) created in one transaction, under the same
project lock (both warehouses are validated as belonging to the _route's_
project; cross-project transfer is rejected with `409
CROSS_PROJECT_TRANSFER_FORBIDDEN` before any write, per §26 of the specification
— there is no future extension point implied, this is a hard MVP rule).

```
sourceCost = apply the §6 outbound formula at the source balance for quantity q
             (including the full-depletion special case if q equals source's
             current quantity)
destination: Q' = Q_dest + q ; V' = V_dest + sourceCost   // §6 receipt formula
```

The exact `sourceCost` value removed from the source is the exact value added to
the destination — never independently recomputed at the destination from its own
average. A deferred constraint trigger verifies, per transfer operation, that the
two legs reference the correct warehouses/material and their quantity/value
deltas are exactly opposite. If the destination-side write fails for any reason,
the whole transaction rolls back and the source balance is left completely
untouched — no observable state has stock "in flight."

## 8. Cancellation / reversal algorithm

See [ADR 0004](adr/0004-dependency-ordered-cancellation.md) for the rationale.

Every balance (`InventoryBalance`) tracks its current **effective head**: the ID
of the most recent movement that actually determines its current
`(quantity, valueUzs)`. Every movement records the balance's `before`/`after`
quantity and value, and the ID of the effective head it replaced.

**Algorithm, inside the project lock:**

1. Verify the target operation is not already cancelled
   (`PURCHASE_ALREADY_CANCELLED` / equivalent if it is).
2. For every balance the original operation touched, require its current
   effective head to still equal a movement from this original operation.
   If any affected balance has moved on (a later purchase/write-off/transfer
   changed it), reject with `409 CANCELLATION_HAS_DEPENDENCIES` /
   `PURCHASE_HAS_DEPENDENT_MOVEMENTS`, naming the blocking operation(s) the
   caller has access to. Having "enough quantity currently in stock" is
   irrelevant here — the check is about the average-cost dependency chain, not
   about whether the numbers would still add up superficially.
3. For a purchase specifically: additionally require that no _settlement_
   allocation against it (payment or advance consumption) is still in effect
   and unreversed. Reverse those first, or reject.
4. Append inverse `StockMovement`/`SettlementAllocation`/`FinancialTransaction`
   rows (`effect = REVERSE` / signed opposite amounts), using the **exact stored
   quantities and values from the original** — never recomputed from today's
   average or today's rate. Restore each affected balance to its pre-operation
   `(quantity, valueUzs)` and reset its effective head to the original's
   _previous_ head (popping the head, not deleting history).
5. Mark the original `cancelledAt`/`cancellationReason`; insert the audit entry;
   commit all of the above together, or none of it.

Popping a head is not destructive: cancelling a later write-off can make an
earlier receipt eligible for cancellation again (its head becomes current once
more). A transfer's two legs are cancelled together or not at all (both must be
heads). Reversal rows are themselves never cancellable (`reversalOfId` is unique
per original; a reversal has no reversal).

**Standalone financial and supplier cancellation** follow the same shape without
the balance-head machinery: an opposite-direction `FinancialTransaction` linked
via `reversalOfId`, identical amount/currency/rate/category snapshot; a supplier
payment cancellation reverses its allocations and its cash row and reopens the
debt it settled; an advance-funding cancellation requires every allocation that
consumed it to be reversed first.

## 9. Invariant matrix

| #   | Invariant                                                  | Enforcement                                                                                                                                                                                       | Failure behavior                                                                                    | Test                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Manager mutates only own project                           | Route `projectId` compared to the actor's assigned project, re-checked inside the transaction (not from JWT claims alone)                                                                         | `403 PROJECT_ACCESS_DENIED`                                                                         | e2e: manager of project A `POST`s to project B's finance/purchase/inventory routes → 403, no row created                                                                                                                       |
| 2   | Owner/Accountant never mutate                              | Role guard on every write route + service-level role re-check as defense in depth                                                                                                                 | `403`                                                                                               | e2e: owner and accountant each attempt every write route → 403                                                                                                                                                                 |
| 3   | Supplier belongs to project                                | Composite FK `(projectId, supplierId)` on every referencing table + query always scoped by route project                                                                                          | `404` (existence hidden) or `409 SUPPLIER_PROJECT_MISMATCH` on an ID reused across a workflow input | integration: purchase referencing a supplier ID that belongs to another project                                                                                                                                                |
| 4   | Warehouse belongs to project                               | Composite FK + scoped query                                                                                                                                                                       | `409 WAREHOUSE_PROJECT_MISMATCH`                                                                    | same pattern, warehouse                                                                                                                                                                                                        |
| 5   | Material belongs to project                                | Composite FK + scoped query                                                                                                                                                                       | `409 MATERIAL_PROJECT_MISMATCH`                                                                     | same pattern, material                                                                                                                                                                                                         |
| 6   | Floor belongs to the specified block, block to the project | Composite FK `(projectId, blockId, floorId)`                                                                                                                                                      | `404`/`409` block-floor mismatch                                                                    | integration: write-off with a floor ID that belongs to a different block                                                                                                                                                       |
| 7   | Negative stock forbidden                                   | `CHECK quantity >= 0` on `InventoryBalance`, service pre-check for sufficient stock inside the project lock, re-verified on every retry                                                           | `409 INSUFFICIENT_STOCK`                                                                            | concurrency: two write-offs racing against 20 units of stock where each requests 15 — exactly one succeeds                                                                                                                     |
| 8   | `quantity = 0 ⇒ valueUzs = 0`                              | `CHECK`, plus the hardcoded full-depletion branch in §6 (never derived by subtraction)                                                                                                            | write rejected if ever violated (should be unreachable)                                             | integration: write off the entire balance, assert `valueUzs` is exactly `0`                                                                                                                                                    |
| 9   | Advance never over-consumed                                | Deferred aggregate check `Σ effective settlementAmount <= fundedAmount` per advance lot, inside the project lock                                                                                  | `409 ADVANCE_EXCEEDS_AVAILABLE`                                                                     | concurrency: two purchases racing to each consume the same 20m advance fully — only one succeeds, or the second is rejected/short-allocated per the caller's explicit request, never silently over-consumed                    |
| 10  | Debt never overpaid beyond remaining                       | Deferred aggregate check `Σ effective debtAmountSettled <= purchase.totalAmount`, inside the project lock                                                                                         | `409 DEBT_PAYMENT_EXCEEDS_REMAINING`                                                                | integration: attempt to allocate 40m against a 30m remaining debt                                                                                                                                                              |
| 11  | Purchase total = Σ item totals                             | Server computes the total from items server-side (client-supplied total is never trusted); deferred trigger re-verifies the sum at commit                                                         | `409` (defense-in-depth; unreachable via the normal API)                                            | unit: largest-remainder allocation test sums exactly to the invoice UZS total across many fractional lines                                                                                                                     |
| 12  | Transfer out = transfer in (qty and value)                 | Deferred constraint trigger checking both legs of a transfer operation are opposite and reference the correct warehouses/material                                                                 | Insert rejected at commit (defense-in-depth; the single transaction already guarantees this)        | integration: forcibly break the destination leg in a test harness and confirm the trigger (or the transaction rollback) prevents a one-sided transfer from ever being visible                                                  |
| 13  | Cross-project transfer forbidden                           | Application check `source.projectId === destination.projectId === route.projectId` before any write                                                                                               | `409 CROSS_PROJECT_TRANSFER_FORBIDDEN`                                                              | e2e: transfer naming a destination warehouse from another project                                                                                                                                                              |
| 14  | Historical FX immutable                                    | No update endpoint for posted rate/amount fields; a trigger denies `UPDATE` of posted monetary fields on `FinancialTransaction`/`Purchase`/`SupplierPayment`/`SettlementAllocation`               | reject at the database layer even if application code attempted it                                  | integration: record a purchase at a given rate, add a new `CurrencyRate` row the next day, assert the original purchase's stored rate and UZS amount are unchanged                                                             |
| 15  | Write-off valuation immutable                              | `StockMovement` is insert-only; a trigger denies `UPDATE`/`DELETE` of posted rows                                                                                                                 | same                                                                                                | integration: write off material, then post a new purchase that changes the average; assert the earlier movement's `totalCostUzs` is unchanged                                                                                  |
| 16  | Cancellation respects dependency order                     | Effective-head check per affected balance (§8); unreversed-settlement check for purchases                                                                                                         | `409 PURCHASE_HAS_DEPENDENT_MOVEMENTS` / `409 CANCELLATION_HAS_DEPENDENCIES`                        | integration: purchase A then purchase B of the same material; cancelling A is rejected until B is reversed; cancelling B then A succeeds                                                                                       |
| 17  | Purchase is atomic                                         | Single Prisma interactive transaction, §4                                                                                                                                                         | any failure (including the audit insert) rolls back every row from every step                       | integration: inject a failure at each step in turn (test-only hook) and assert zero rows exist in `Purchase`, `PurchaseItem`, `StockMovement`, `SettlementAllocation`, `FinancialTransaction`, and `AuditLog` for that attempt |
| 18  | Transfer is atomic                                         | Single transaction, §7                                                                                                                                                                            | destination failure leaves source completely untouched                                              | integration: force the destination-balance write to fail; assert the source balance/quantity/value/history are bit-for-bit unchanged                                                                                           |
| 19  | Debt payment is atomic                                     | Single transaction: allocation(s) + `FinancialTransaction` + audit                                                                                                                                | rollback on any failure                                                                             | integration test with an injected late failure                                                                                                                                                                                 |
| 20  | Advance consumption is atomic                              | Single transaction: allocation + purchase linkage + audit, no cash row created                                                                                                                    | rollback on any failure                                                                             | integration test                                                                                                                                                                                                               |
| 21  | Duplicate submissions produce exactly one operation        | `PostedOperation` unique `(projectId, actorId, operationKind, idempotencyKey)` + request hash (§3)                                                                                                | replay returns the committed result; payload drift returns `409 IDEMPOTENCY_KEY_REUSED`             | concurrency: fire the identical purchase request twice concurrently with the same key — exactly one `Purchase` row exists afterward                                                                                            |
| 22  | Cross-currency settlement requires an explicit rate        | `CHECK (settlementExchangeRate IS NULL) = (debtCurrency = 'UZS' OR debtCurrency = settlementCurrency)`, rate `> 0` when present, service rejects a missing/omitted required rate before any write | `409 SETTLEMENT_RATE_REQUIRED`                                                                      | integration: settle a USD debt with UZS cash and no rate → rejected; with an explicit rate → succeeds with the exact `debtAmountSettled` from §5's formula                                                                     |
| 23  | Audit exists for every critical operation                  | Audit insert happens inside the same transaction as the business effect; a deferred check requires a matching audit row per operation kind at commit                                              | the whole operation rolls back if the audit insert fails                                            | integration: simulate an audit-insert failure and confirm no orphan business rows exist afterward                                                                                                                              |

## 10. Error catalog referenced by this document

`PROJECT_ACCESS_DENIED`, `SUPPLIER_PROJECT_MISMATCH`, `WAREHOUSE_PROJECT_MISMATCH`,
`MATERIAL_PROJECT_MISMATCH`, `INSUFFICIENT_STOCK`, `ADVANCE_EXCEEDS_AVAILABLE`,
`DEBT_PAYMENT_EXCEEDS_REMAINING`, `SETTLEMENT_RATE_REQUIRED`,
`PURCHASE_ALREADY_CANCELLED`, `PURCHASE_HAS_DEPENDENT_MOVEMENTS`,
`CANCELLATION_HAS_DEPENDENCIES`, `CROSS_PROJECT_TRANSFER_FORBIDDEN`,
`IDEMPOTENCY_KEY_REUSED`, `CONCURRENT_MODIFICATION`. Full response shape and HTTP
status mapping live in backend-architecture.md §9; this list exists so a workflow
implementer can find every code this document's algorithms can produce without
re-deriving it from prose.

## 11. Supporting research

Primary-source verification of the Prisma/PostgreSQL claims used throughout this
document (interactive transaction semantics, `P2034` mapping, `SELECT ... FOR
UPDATE` behavior, deferred constraint trigger limitations, Decimal.js behavior) is
recorded separately in [research/transaction-design.md](research/transaction-design.md)
and is not repeated here.
