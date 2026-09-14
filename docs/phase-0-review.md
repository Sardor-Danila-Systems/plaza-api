# Phase 0 review

Status: 2026-09-13. This is the required independent second review of the Phase 0
design (specification §72 / §41), performed after
[backend-architecture.md](backend-architecture.md),
[backend-data-model.md](backend-data-model.md), and
[transaction-design.md](transaction-design.md) were written and revised against
the second, more detailed specification. No production code exists yet — the repo
is still the unmodified Nest starter (`git log`: `09269a0 initial commit from
Nest`) — so this review is of the design, not of an implementation.

## 1. Baseline verification

The repository has no `package.json` scripts beyond the Nest starter defaults, no
`prisma/` directory, no `src/modules/`, and no CI configuration. `npm run lint`,
`npm test`, and `npm run build` all pass trivially against the starter's single
`AppController`/`AppService`, which proves nothing about business logic that
doesn't exist yet. There is nothing to typecheck, migrate, or integration-test
until Phase 1 creates the foundation. This is expected for a Phase 0 deliverable
and is recorded here so the phase-gate is not mistaken for having skipped
verification.

## 2. What changed in this revision

The second specification resolved one previously-open assumption and sharpened
two others. Changes made to the design as a result:

1. **Cross-currency debt settlement is now required, not rejected.** The first
   draft chose the conservative default of rejecting any settlement whose
   currency didn't match the purchase (`SETTLEMENT_CURRENCY_MISMATCH`), pending
   business confirmation. §8 of the second specification confirms the opposite:
   a USD debt may be paid in UZS (or vice versa) provided the caller explicitly
   confirms the conversion rate for that settlement. This required redesigning
   `SettlementAllocation` (dropping `currency` from the compound uniqueness key,
   splitting it into `settlementCurrency`/`debtCurrency`/`settlementExchangeRate`/
   `debtAmountSettled`) and is recorded as [ADR 0006](adr/0006-cross-currency-settlement-explicit-rate.md)
   with the full arithmetic in [transaction-design.md §5](transaction-design.md#5-settlement-allocation-cross-currency-settlement).
2. **Full-depletion write-off is now a hardcoded branch, not a formula that
   happens to land on zero.** §23 of the second specification makes explicit
   what the first draft stated as a buried exception: `q = Q` must set
   `quantity/value/averageCost` to exactly `0` by assignment, never by trusting
   `round8(V * q / Q)` to reproduce `V` exactly. [transaction-design.md §6](transaction-design.md#6-inventory-receipt-and-write-off-formulas)
   now states this as two clearly separated cases with an explicit warning
   against the naive approach.
3. **Error code naming is now pinned to the specification's exact strings**
   (`ADVANCE_EXCEEDS_AVAILABLE`, `DEBT_PAYMENT_EXCEEDS_REMAINING`,
   `MATERIAL_PROJECT_MISMATCH`, `CROSS_PROJECT_TRANSFER_FORBIDDEN`,
   `PURCHASE_HAS_DEPENDENT_MOVEMENTS`) rather than the first draft's
   near-equivalents, to remove ambiguity for whoever implements the DTOs and
   exception filter in later phases.

The transaction/concurrency/cancellation material that was previously inline in
`backend-architecture.md` §§6–8 has also been extracted into the new
[transaction-design.md](transaction-design.md), which is now the single
authoritative location for those algorithms and carries the full invariant
matrix required by specification §41/§71. `backend-architecture.md` now links to
it instead of duplicating it, per the `writing-for-agents` skill's "one
authoritative location per decision" principle — avoiding the two documents
silently drifting apart on a formula.

## 3. Second-pass review findings

Reviewed specifically for: broken financial invariants, race conditions,
incorrect Decimal handling, incorrect weighted-average costing, unsafe
cancellation, debt drift, advance drift, project authorization bypass, unsafe
cascade delete, missing constraints/indexes, ambiguous transaction boundaries,
external side effects inside retryable transactions, and unnecessary
overengineering.

### Resolved in this revision (no business clarification needed)

- **Cross-currency settlement arithmetic** — resolved per §2 above; formula is
  fully specified with worked examples and a rounding-residue rule so debt can
  never go negative from rounding.
- **Full-depletion Decimal risk** — resolved per §2 above; the rule is now
  "assign zero," never "compute and hope for zero."
- **Transaction/concurrency material duplicated across documents** (a Phase-0
  self-review finding from the first draft: `backend-architecture.md` §§6–8
  fully restated what should have been one authoritative source) — resolved by
  extraction into `transaction-design.md`.
- **Broken self-reference** (`backend-architecture.md` linked to a
  `phase-0-review.md` that didn't exist) — resolved: this file now exists.
- **Missing invariant-by-invariant matrix in explicit table form** (specification
  §41/§71 requires `Invariant | Enforcement | Failure behavior | Test`; the first
  draft had this information but spread across prose) — resolved:
  [transaction-design.md §9](transaction-design.md#9-invariant-matrix) is now
  exactly that table, with 23 rows covering every item the specification lists
  plus idempotency and audit.
- **Deferred trigger invariants stated as unchecked prose** — partially
  addressed: the invariant matrix now states the exact `CHECK`/deferred-trigger
  condition per row (e.g. the cross-currency rate `CHECK`, the
  `quantity = 0 ⇒ value = 0` `CHECK`) rather than a generic "a trigger exists"
  statement. The trigger _function bodies_ (actual `CREATE TRIGGER` SQL) are
  still not drafted — that is appropriately a Phase 1/4/5/7 migration-authoring
  task, not a Phase 0 design task, but the _condition_ each trigger must enforce
  is now unambiguous, which is what Phase 0 owes the implementer.
- **No `Supplier.debt`/`Supplier.advance` scalar anywhere** — verified still
  true after the redesign; the new `debtAmountSettled`/`settlementAmount`
  fields are allocation-level facts, not a mutable aggregate.

### Checked and found sound (no change needed)

- **Authorization bypass** — every project-owned table uses a composite FK
  back to `(projectId, id)` of its parent, so a cross-project ID cannot be
  substituted without a database-level rejection in addition to the
  service-level check; the project lock re-validates session/role/assignment
  inside the transaction, not from JWT claims alone, which closes the
  "assignment revoked mid-request" race.
- **Unsafe cascade delete** — every FK is `RESTRICT`/`RESTRICT` by default;
  historical tables have no delete path at all, only `isActive`/cancellation.
  No model in the design uses `onDelete: Cascade` on a financial or inventory
  table.
- **Weighted-average costing** — the authoritative value is always
  `(quantity, valueUzs)`; average is derived on read, never independently
  stored and mutated, so there is no "average column drifts from the underlying
  totals" failure mode by construction.
- **Debt/advance drift under concurrency** — both are computed as
  `total − Σ effective allocations`, re-summed inside the project lock on every
  write, with a deferred aggregate trigger as backstop; there is no cached
  running total that could desync from its ledger.
- **Idempotency race handling** — explicitly requires reading the winning
  result in a fresh transaction on a key-collision race rather than swallowing
  the unique violation generically, avoiding a subtle bug class where a
  legitimate duplicate-key error gets misclassified as an idempotent replay.
- **Overengineering** — no repository-per-model layer, no CQRS, no event
  sourcing, no duplicated domain entities were introduced; `PostedOperation` is
  the one cross-cutting extra model, justified because idempotency and
  operation-level audit genuinely need a place to live that isn't any single
  business table. This was checked against the "avoid unnecessary abstractions"
  constraint specifically, not assumed.

### Newly identified in this pass (documented, not blocking)

- **`exchangeDifferenceUzs` sign convention should be pinned before Phase 6/7
  implementation.** The formula in transaction-design.md §5 defines it as
  `settlementValueUzs − round(debtAmountSettled × invoiceRate, 2)`, positive
  meaning the settlement cost more UZS-equivalent value than the debt was
  originally recorded at (a loss from the project's perspective). This sign
  convention is stated once, but no DTO/report field name yet distinguishes
  "loss" from "gain" for a frontend consumer — flagged as a Phase 6/10
  implementation detail, not a design gap, since the underlying number is
  unambiguous.
- **`SettlementAllocation.settlementExchangeRate` scale.** It expresses "UZS per
  one unit of `debtCurrency`," which reuses the existing `Decimal(24,8)` rate
  column shape from backend-architecture.md §4 — this was verified consistent
  rather than assumed, but is worth double-checking in Phase 1's schema
  validation pass since it's a new use of that scale (rate keyed by debt
  currency rather than by a `CurrencyRate.currency` row).
- **Advance denominated in a currency the project has never otherwise
  used.** Nothing in the design prevents funding an advance in, say, USD for a
  project whose every other operation happens to be UZS. This is intentional
  (currencies are UZS/USD system-wide per §6 of the specification, not
  restricted per-project), noted here only so it isn't mistaken for an
  oversight.

## 4. Invariant coverage cross-check

Every invariant named in specification §41/§71 has a corresponding row in
[transaction-design.md §9](transaction-design.md#9-invariant-matrix):
manager-own-project (row 1), owner/accountant read-only (row 2), supplier/
warehouse/material/block/floor project membership (rows 3–6), negative stock
forbidden (row 7), zero-quantity-zero-value (row 8), advance not over-consumed
(row 9), debt not overpaid (row 10), purchase total reconciliation (row 11),
transfer conservation (row 12), cross-project transfer forbidden (row 13),
historical FX/write-off immutability (rows 14–15), dependency-ordered
cancellation (row 16), and atomicity of purchase/transfer/debt-payment/advance-
consumption (rows 17–20). Idempotency (row 21), the new cross-currency rate
requirement (row 22), and required audit (row 23) were added beyond the
specification's explicit list because they are equally load-bearing invariants
this design depends on.

## 5. Remaining assumptions requiring business confirmation

These cannot be resolved conservatively without materially guessing at intended
behavior; each currently has a documented conservative default so Phase 1–7 is
not blocked, but should be confirmed before the phase that first exercises it
ships to real users:

| #   | Assumption                                                                                                                                                                                                                                                     | Current conservative default                                                                                                                                                                                                                                                                                                                                                                                                                 | First phase affected           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 1   | Who provisions the first OWNER/ACCOUNTANT/PROJECT_MANAGER accounts and projects, given all three roles are otherwise read-only or single-project?                                                                                                              | **Resolved and implemented in Phase 3**: `ProjectProvisioningService` + `src/cli/provision.ts`, outside the authenticated HTTP API entirely (ADR 0014). No longer open.                                                                                                                                                                                                                                                                      | Phase 2–3 (done)               |
| 2   | Can a `PROJECT_MANAGER`'s project assignment ever change (reassignment to a different project), and if so, does it retroactively affect audit visibility of their prior work?                                                                                  | **Resolved and implemented in Phase 3**: reassignment deactivates the outgoing manager (their historical `role`/`projectId` are never rewritten) and activates the incoming one, atomically; the outgoing manager's existing access token stops working on its very next request via Phase 2's existing per-request revalidation, with no new mechanism (ADR 0013). Verified against real PostgreSQL and real HTTP requests. No longer open. | Phase 2–3 (done)               |
| 3   | Is there any scenario where OWNER needs write access (e.g. emergency correction), or is OWNER permanently and absolutely read-only with no override?                                                                                                           | Absolutely read-only, no override, no "break-glass" endpoint — reconfirmed in Phase 3 (no `POST /projects`, no OWNER write path added anywhere).                                                                                                                                                                                                                                                                                             | Phase 2 (confirmed in Phase 3) |
| 4   | When an advance is funded in currency A and later used against a purchase in currency B, does the business want the settlement rate confirmed _at consumption time_ (current design) or does it want to lock a rate _at funding time_ for later automatic use? | Confirmed at consumption time only; funding time never presumes a future conversion.                                                                                                                                                                                                                                                                                                                                                         | Phase 6–7                      |
| 5   | Should a `PROJECT_MANAGER` be able to see cancelled/historical operations from before their assignment began, or only from their tenure?                                                                                                                       | Full project history is visible to the currently assigned manager (project-scoped, not tenure-scoped) — consistent with "the project's own record," not the individual's.                                                                                                                                                                                                                                                                    | Phase 3–4                      |
| 6   | Retention/legal-hold requirements for financial records (statutory retention period, right-to-erasure conflicts) are unspecified.                                                                                                                              | No deletion of posted financial/inventory history is implemented at all in MVP (append-only forever); this is a placeholder assumption pending a real answer, not a considered legal position.                                                                                                                                                                                                                                               | Post-MVP                       |

## 6. Phase 1 readiness

Nothing above blocks starting Phase 1. Items in §5 are documented risks with safe
defaults, not open design questions that change the schema shape Phase 1 would
build on. The cross-currency settlement rework (§2) is the one change with real
schema impact from the first draft, and it is now fully reflected in both
`backend-data-model.md` and `transaction-design.md` consistently.

## 7. Phase 1 implementation findings (2026-09-13)

Phase 1 (foundation only — no business modules) was implemented and verified
against a real local PostgreSQL instance. Two things could not have been known
from design alone and are recorded here because they affect every later phase's
Prisma usage:

- **`PrismaClient` cannot be subclassed under Prisma ORM v7.** The classic
  `class PrismaService extends PrismaClient` pattern silently breaks —
  `instanceof` on the subclass returns `false` — because the v7 generated
  client's constructor does not preserve subclass identity (verified both
  through Nest's `TestingModule` and with a plain subclass outside any
  framework). `PrismaService` now composes the client
  (`prismaService.client.<model>`) instead of extending it. See
  [ADR 0007](adr/0007-prisma-client-composition-not-inheritance.md). Every
  future phase's services must use `this.prisma.client.*`, not
  `this.prisma.*`.
- **Jest requires real ESM mode (`--experimental-vm-modules`), not the more
  common "transform TS to CommonJS" Jest setup.** The v7 generated client
  uses `import.meta.url` internally, which a `require()`-based test runner
  cannot load at all. This is now wired into `npm test`/`npm run test:e2e`
  (see `jest.config.js`) and documented in the README; it remains an
  officially "experimental" Node/Jest flag worth watching on future Jest
  upgrades, not a fully stable, permanent guarantee.
- **Database-unavailable-at-boot behavior was underspecified and resolved
  conservatively toward availability.** `PrismaService.onModuleInit` does not
  rethrow a connection failure — the application stays up and `GET /health`
  reports the outage via its own live query, rather than crash-looping the
  whole process over a transient database blip. Config _validity_
  (`DATABASE_URL` is a well-formed connection string) still fails startup
  fast via `env.validation.ts`; only live _reachability_ is handled this way.
  This reads `docs/backend-architecture.md §3`'s "health should clearly
  reflect [database unavailability]" as an ongoing operating mode, not only a
  boot-time gate — flagged here in case that reading is wrong.
- **`@nestjs/observe` (wired with placeholder credentials in the original
  starter) was removed entirely**, not merely made opt-in as the Phase 0
  baseline findings suggested. A third-party telemetry SaaS with fake
  credentials attempting to phone home on every boot (including tests) is a
  worse default for a financial system than no telemetry at all; a real
  observability integration can be added deliberately in a later phase with
  real credentials and explicit opt-in.

None of these change any invariant, schema shape, or business rule from
Phase 0 — they are implementation-level corrections a design document
couldn't have caught, now fixed and tested. See the Phase 1 report for the
full file list and quality-gate results.

## 8. Phase 2 implementation findings (2026-09-13)

Phase 2 (authentication, roles, project-access foundation — no Project CRUD)
was implemented and verified against real PostgreSQL, including a real
concurrent-HTTP-request test. Findings only discoverable by writing the code:

- **The refresh-rotation "reuse detection" cannot reliably distinguish a
  genuine concurrent race from a delayed replay attack**, and trying to do so
  (an earlier draft revoked the session only on a delayed replay, not on a
  losing concurrent request) produced non-deterministic test behavior — the
  same request pair passed or failed differently depending on scheduling.
  Resolved by adopting the industry-standard rule instead: any reuse of a
  consumed refresh token revokes the whole session, full stop, matching
  OAuth2 refresh-rotation reuse detection and removing the non-determinism.
  See [ADR 0012](adr/0012-refresh-rotation-concurrency.md). This has a real
  client-side implication documented in the README: never fire two refresh
  requests concurrently for the same session.
- **A disabled account is revealed only after a correct password**, not
  folded into the generic unknown-user/wrong-password response, because the
  specification explicitly wants a distinct `USER_DISABLED` code — resolved
  by ordering the check after password verification so no enumeration signal
  reaches someone who doesn't already know the password. See
  [ADR 0011](adr/0011-disabled-user-login-ordering.md).
- **`GET /health` needed an explicit `@Public()` exemption** the moment
  `JwtAuthGuard` became a global guard — an easy one-route oversight with a
  concrete blast radius (every infra/monitoring probe breaking), caught
  immediately by Phase 1's own e2e tests failing when re-run against Phase 2's
  code. Recorded here as a reminder that every later phase adding a global
  guard must re-audit which existing routes need `@Public()`.
- **Prisma's schema language has no cross-column conditional CHECK**
  (`@@check(...)` is not valid Prisma v7 syntax, confirmed by
  `prisma validate` rejecting it outright) — the approved
  `role = 'PROJECT_MANAGER' iff projectId IS NOT NULL` constraint is added by
  hand to the migration SQL, verified directly against PostgreSQL (a manual
  `INSERT` violating it fails as expected). See
  [ADR 0008](adr/0008-manual-sql-check-constraints.md).
- **`@nestjs/throttler`'s latest release (6.5.0) does not yet declare peer
  support for `@nestjs/core@^12`** (this project's version, checked directly
  against the npm registry). Rather than force an unresolved peer
  dependency, Phase 2 uses a small hand-rolled in-process rate limiter,
  explicitly documented as single-instance/non-distributed. Swappable for a
  Redis-backed implementation later behind the same guard interface without
  changing any call site.

None of these change a Phase 0 invariant. See the Phase 2 report for the full
file list, test coverage, and quality-gate results.

## 9. Phase 3 implementation findings (2026-09-14)

Phase 3 (the real Project domain, BuildingBlock/Floor construction structure,
project/manager provisioning) was implemented and verified against real
PostgreSQL, including direct SQL-level constraint tests and a real concurrent
manager-assignment test.

- **A genuine, empirically-verified incompatibility between `tsx`/esbuild and
  Nest's dependency injection.** Building the operator provisioning CLI
  surfaced two escalating bugs when booting the real `AppModule` via `tsx`:
  first `class-validator`'s `enableImplicitConversion` silently failed to
  coerce `PORT` from string to number, then — after fixing that — Nest's own
  constructor-based DI failed to construct `PrismaService` at all. Both trace
  to the same cause (esbuild does not emit `emitDecoratorMetadata` output);
  confirmed by comparing an identical `tsx`-run copy against a `tsc`-compiled
  copy side by side. Fixed by making `env.validation.ts`'s numeric field use
  an explicit `@Type(() => Number)` (a genuine robustness improvement,
  independent of which tool runs it) and by requiring any tool that boots
  `AppModule` to run from compiled `dist/` output, never `tsx` — see
  [ADR 0015](adr/0015-cli-tools-requiring-nest-di-must-run-compiled.md).
  `prisma/seed.ts` was never affected (no Nest DI in its own graph) and needed
  no change.
- **Prisma v7 supports partial/filtered unique indexes, but only behind the
  `partialIndexes` preview feature** (verified directly: a plain
  `@@unique([projectId], where: {...})` is rejected by `prisma validate`
  unless that preview feature is enabled). Consistent with this project's
  general avoidance of non-stable Prisma functionality, the
  "one active PROJECT_MANAGER per project" constraint is hand-written SQL
  instead — see [ADR 0013](adr/0013-project-manager-relation.md).
- **An internal inconsistency in this document's own Route Surface section**
  (§9, "Authentication, authorization, and API contracts") was found and
  corrected: it claimed "all business routes are beneath `/api/v1`" while its
  own route table already listed `/auth`, `/users`, and `/projects`
  unprefixed, and Phase 1/2 had already shipped `/auth`/`/health` unprefixed.
  Resolved by matching actual shipped behavior (no global prefix) rather than
  retrofitting a prefix with no real requirement driving it — see the Route
  Surface section's own correction note for detail.
- **Manager reassignment's exact mechanism** (deactivate the outgoing
  manager, activate the incoming one, atomically, backed by a partial unique
  index rather than a second `Project.managerId` column) was designed and
  verified end to end against real PostgreSQL and real HTTP requests,
  resolving the Phase 0 assumption recorded in §5 rows 1–2 above.

None of these change a Phase 0 invariant. See the Phase 3 report for the full
file list, test coverage, and quality-gate results.

## 10. Phase 3.1 correction (2026-09-14)

Requested alongside Phase 3's approval: `PATCH /projects/:projectId` (project
rename) was removed as a manager-writable endpoint. "PROJECT_MANAGER may
operate on their project's content" does not imply "may change the project's
own administrative identity" — `name`/`code`/`timezone`/`isActive`/manager
assignment are all the same kind of fact, and only manager assignment had
ever been routed through provisioning. Renaming now goes through
`ProjectProvisioningService.renameProject`, CLI-only, exactly like creation
and manager assignment; no substitute write path was given to OWNER. See
[ADR 0014](adr/0014-project-provisioning-outside-http-api.md)'s "Phase 3.1
correction" note. No Phase 0 invariant changed; this narrows a Phase 3
implementation choice, not the approved architecture.

## 11. Phase 4 implementation findings (2026-09-14)

Phase 4 (the financial ledger: `Currency`, `CurrencyRate`, `TransactionCategory`,
`FinancialTransaction`, income/expense/salary posting, comment edits,
cancellation/reversal, the project-lock/Serializable/retry protocol's first
real implementation, idempotency, and a minimal transactional audit writer)
was implemented and verified against real PostgreSQL, including direct
SQL-level constraint/trigger tests and real concurrent-load tests that force
genuine Serializable conflicts.

- **A genuine contradiction between the approved architecture and this
  phase's stated scope, surfaced rather than silently resolved:**
  docs/backend-architecture.md §10 requires the transactional audit writer to
  exist "before the first financial posting in Phase 4" (invariant #23 — no
  successful financial operation without audit), but this phase's own
  instructions enumerated currency/FinancialTransaction/income/expense/salary
  as owned scope with no mention of an audit table or writer. Put to the user
  directly rather than picked either way silently; the answer was to add a
  minimal writer now (no read endpoint, no attachment integration — both stay
  Phase 9's job per that same section). See
  [ADR 0016](adr/0016-minimal-audit-writer-phase4.md).
- **My own draft schema initially contradicted the already-approved
  architecture, caught before it reached a migration a second time:**
  docs/backend-architecture.md §4 is explicit that "For UZS, exchangeRate = 1
  and amountUzs = amount" — a first draft instead made `exchangeRate` nullable
  and null-for-UZS, a rule I invented rather than one anywhere approved. Found
  by re-reading §4 line by line against the schema before treating the design
  as final, corrected (exchangeRate NOT NULL always, `= 1` for UZS enforced by
  a CHECK constraint) via a follow-up migration before any application code
  was built on the wrong assumption.
- **A real bug in a hand-written CHECK constraint, found only by an e2e test
  actually exercising the path, not by re-reading the SQL:**
  `FinancialTransaction_direction_matches_type_check` initially assumed
  `type` determines `direction` 1:1. docs/backend-architecture.md's
  cancellation rules are explicit that a reversal "creates an
  opposite-direction transaction of the original business type" — i.e. a
  reversal of an INCOME row is itself still `type = INCOME` but
  `direction = OUT`, which the original constraint rejected outright. The
  cancellation e2e test hit this immediately; fixed by exempting any row with
  `reversalOfId IS NOT NULL` from the check, in a follow-up migration.
- **A second, independent bug in the immutability trigger, same root
  cause (drafted from a plausible-sounding rule, not from the exact text):**
  the first version of `financial_transaction_prevent_illegal_update` treated
  a cancelled row as fully immutable, including its `comment` field. The
  business-rules table ("What may be edited or removed?") is explicit that
  "comments and attachments may be edited with audit" — i.e. `comment` stays
  editable even after cancellation, only the three cancellation fields
  themselves become final. Corrected via `CREATE OR REPLACE FUNCTION` in a
  follow-up migration (the trigger's binding to the function name needed no
  change), verified by direct-database tests for both the "comment edits
  after cancellation succeed" and "re-cancellation is rejected" cases.
- **A genuinely non-obvious Prisma/adapter error-shape finding, discovered
  only by forcing a real conflict and printing the result, not by reading
  Prisma's own error-code documentation:** `docs/transaction-design.md`'s
  retry protocol requires catching a Serializable write conflict, which
  Prisma's query-builder methods surface as `P2034` — but this service's own
  `SELECT ... FOR UPDATE` (necessarily issued via `$queryRaw`, since Prisma
  has no query-builder equivalent) surfaces the same conflict as generic
  `P2010`, with the actual classification nested three levels deep as
  `meta.driverAdapterError.cause.kind === 'TransactionWriteConflict'` — not
  as a bare SQLSTATE on `.code`, and not as `meta.code`, both of which were
  tried first and were both wrong. Getting this wrong doesn't crash
  visibly — it silently fails to retry a real conflict, surfacing as a raw
  500 instead, exactly the failure mode the retry protocol exists to
  prevent. See [ADR 0017](adr/0017-raw-query-serialization-error-shape.md);
  the concurrency test that found this keeps forcing the same real conflict
  today, so a future Prisma/adapter upgrade that changes this shape again
  fails the test loudly rather than silently.
- **The cash-negative-balance policy question** (explicitly flagged for
  review rather than assumed) is answered by docs/backend-architecture.md §2
  directly: "Reject spending beyond the project's recorded balance in that
  original currency... never infer USD availability from a UZS reporting
  balance." Implemented as a per-currency nominal-balance check
  (`sum(IN) - sum(OUT)` for that transaction's own currency) before any
  OUT-direction row is posted, including an income-cancellation's reversal —
  no new policy was invented here, the approved answer already existed.
- **The `POST /finances` route accepts one unified DTO with type-conditional
  fields**, not separate income/expense/salary endpoints, to match
  docs/backend-architecture.md's route table (`GET/POST P/finances` as a
  single collection route). `source` (income) and `recipient` (expense/
  salary) are separate API fields mapping to the same `recipient` database
  column — the schema's approved shape uses `recipient` for both, the
  original Phase 4 instructions used "source" for income; both are satisfied
  by keeping the column name and branching only the DTO-facing field name.
- **Deliberately deferred, not silently dropped:** `PURCHASE`/`ADVANCE`/
  `DEBT_PAYMENT`/`REFUND`/`ADJUSTMENT` all exist on `FinancialTransactionType`
  (matching the approved enum) but have no posting workflow yet — Phase 0's
  phase-plan table lists "opening adjustment/refund" under Phase 4's original
  scope, but this phase's actual instructions scoped posting down to income/
  expense/salary only, explicitly excluding inventory/warehouses/suppliers/
  purchases. `CurrencyRate.source = PROVIDER` (an automatic rate-provider
  integration) is likewise declared but has no writer — explicitly deferred
  per docs/backend-architecture.md §2 ("Automatic rate retrieval is
  optional"). Both are schema-ready, not workflow-ready.
- **A rare, unreproduced e2e flake under heavy combined concurrent load,
  worth naming rather than hiding:** across roughly a dozen full and
  partial e2e runs during this phase's verification, one single run
  produced a transient failure consistent with the project-lock's
  documented, bounded retry exhaustion (three attempts) rather than any
  logic error — every other run, including several immediately before and
  after, passed cleanly, and the specific failing assertion was not
  captured before the run completed. Recorded here rather than dismissed:
  if this recurs with a reproducible pattern, it should be investigated as
  a possible signal that `MAX_ATTEMPTS = 3` is too low for this test
  environment's contention level, not brushed aside a second time.

None of these change a Phase 0 invariant; the UZS-exchangeRate and
direction-matches-type findings are corrections of this implementation's own
draft against already-approved text, not changes to that text. See the
Phase 4 report for the full file list, test coverage, and quality-gate
results.
