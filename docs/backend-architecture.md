# Euro Plaza backend architecture

Status: Phase 0 design approved 2026-09-13; **Phase 1 (foundation), Phase 2
(authentication, roles, project-access foundation), Phase 3 (the real Project
domain, BuildingBlock/Floor construction structure), Phase 3.1 (authorization
hardening: project metadata is provisioning-only, never manager-writable), and
Phase 4 (the financial ledger — currencies, FX, FinancialTransaction,
income/expense/salary posting, cancellation/reversal, the project-lock/
Serializable/retry protocol's first real implementation, idempotency, and a
minimal transactional audit writer) implemented and verified the same week**
— see the Phase 1-4 reports for files/gates/decisions. Inventory/supplier/
purchase business endpoints do not exist yet; this document still states
policy, module boundaries, and the API surface those phases will implement.
The exact transaction algorithms, lock/retry protocol, and the full invariant
matrix are the authoritative content of
[transaction-design.md](transaction-design.md) — this document links to it
rather than repeating it. Baseline verification, the Phase 0 review, and
Phase 1-4 implementation findings and remaining open assumptions are recorded
in [phase-0-review.md](phase-0-review.md). Hard-to-reverse decisions with
real trade-offs are recorded individually in [docs/adr/](adr/), including
several found only once real code was written against Prisma ORM v7, the
approved auth design, and the approved project/manager design (ADRs 0007,
0009–0017).

## 1. Product and repository findings

Euro Plaza Group needs independent project records for construction cash,
procurement, supplier obligations, material storage, and consumption. A purchase
records a material receipt and an obligation; only its actual cash payment reduces
cash. Owner and accountant access never implies permission to post operations.

Repository inspection covered every application and test file, root configuration,
the dependency manifest and lockfile, tracked history, and installed skill
entrypoints. At the initial commit `09269a0`, the application is a Nest starter with
one greeting endpoint, one unit test, and one HTTP test. There are no existing
business conventions, database, migration, environment-example, CI, or domain docs.
No `AGENTS.md` or `CLAUDE.md` was found in this repo or applicable ancestor paths.
The existing untracked `.agents/`, `.aider-desk/`, and `skills-lock.json` belong to
the initial workspace and are outside this change.

The manifest requests Nest 12 and TypeScript 6, with ESM/NodeNext imports. Keep those
conventions unless a verified compatibility problem requires a documented change.
Existing tests use Vitest; Phase 1 must migrate them to the requested Jest with
Nest testing utilities, preserving decorator metadata and ESM behavior. Keep
Prettier and Oxlint. The current lint configuration permits explicit `any`; Phase 1
must enable the corresponding prohibition and enforce promise handling without
suppressing errors. Optional Nest Observe is currently wired with placeholder
credentials; Phase 1 must make telemetry opt-in and prevent worker startup in tests.

The skill inventory contains 37 repository skills, 6 system skills, 1 user skill,
and 22 cached plugin skill entrypoints. Relevant guidance applied here:

| Skill                    | Application                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `domain-modeling`        | Canonical business terms in [CONTEXT.md](../CONTEXT.md); explicit edge cases and invariants                                                                                                      |
| `codebase-design`        | Small workflow interfaces with transaction ownership inside the module                                                                                                                           |
| `writing-for-agents`     | One authoritative location per decision and links to detailed reference material                                                                                                                 |
| `to-spec`, `to-tickets`  | Local specification and verifiable phased slices; their tracker-publication steps do not apply to the requested local Phase 0 artifact                                                           |
| `research`               | Independent primary-source investigation recorded in [research/transaction-design.md](research/transaction-design.md), cited by the authoritative [transaction-design.md](transaction-design.md) |
| `tdd`                    | Test strategy at the REST and workflow interfaces required by the specification; implementation loops begin in Phase 1                                                                           |
| `code-review`            | Independent standards and specification review of the new design documents                                                                                                                       |
| `domain-modeling` (ADRs) | Hard-to-reverse, non-obvious, real-trade-off decisions recorded individually in [docs/adr/](adr/) rather than folded into the glossary                                                           |
| `diagnosing-bugs`        | Reproduce baseline failures before attributing them to code or environment                                                                                                                       |

The remaining skills were inspected for applicability. Image generation, plugin
installation, course scaffolding, external issue publication, interviews, and git
workflow changes are not needed for Phase 0. The supplied specification is the
review source; no issue-tracker setup or new approval process is required.

## 2. Business rules and conservative resolutions

The glossary defines business terms; the following table is the authoritative
policy proposal for rules the specification does not fully determine. These are
visible implementation defaults, not assertions about existing company practice.
They can be revised before the relevant phase; posted values will never be
silently reinterpreted when a policy changes.

| Question                                                      | Proposed MVP behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Reason and consequence                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who creates projects/users if owners are read-only?           | Explicit operator CLI for initial provisioning, assignment, password reset, and archival. No public registration or administrative role. **Corrected in Phase 3.1**: managers do NOT edit the project's own administrative identity/metadata (name, code, timezone, active state, manager assignment) — only the CLI does. Managers edit _operational content_ they own within their project (blocks, floors, and later finances/inventory/etc.).                                                                                                                                                                                                                        | Preserves all three stated roles. CLI validates invariants, revokes affected sessions, and audits its operator identity. "Descriptive fields" was an ambiguous phrase that Phase 3's implementation initially read too broadly (as covering project rename); Phase 3.1 resolved it conservatively in the direction of less implicit write authority, not more. |
| Can a manager read another project?                           | No; manager reads and writes are restricted to the assigned project.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Project isolation applies to lists, nested IDs, files, audit, and reports.                                                                                                                                                                                                                                                                                     |
| Who downloads reports?                                        | Accountant and the manager of the project. Owner reads report-equivalent analytics but cannot export in the initial policy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Download permission is expressly granted only to accountants; broader owner export remains an explicit policy change.                                                                                                                                                                                                                                          |
| What is a purchase?                                           | One posted invoice and simultaneous material receipt into one warehouse. No drafts, orders, partial receipts, tax engine, discounts, or landed-cost allocation in MVP. Unit prices are the final agreed acquisition prices.                                                                                                                                                                                                                                                                                                                                                                                                                                              | Avoids inventing purchasing states or monetary components. All supplied items are received atomically.                                                                                                                                                                                                                                                         |
| What currency is supplier debt?                               | Original purchase currency; that denomination never changes over the debt's life. A settlement (payment or advance allocation) **may** use a different currency than the debt (confirmed business rule, superseding the earlier conservative draft — see [ADR 0006](adr/0006-cross-currency-settlement-explicit-rate.md)). Whenever the conversion is not already resolvable through a currency's own recorded UZS rate, the caller must supply an explicit, allocation-specific `settlementExchangeRate`; see [transaction-design.md §5](transaction-design.md#5-settlement-allocation-cross-currency-settlement) for the exact formula and `SETTLEMENT_RATE_REQUIRED`. | Matches confirmed practice: suppliers are commonly paid in whichever currency is on hand. UZS reporting and the debt's own denomination are unaffected; only the settled amount depends on an explicitly confirmed rate, never an inferred one.                                                                                                                |
| Which advance is used?                                        | Client explicitly selects advance IDs and amounts; no automatic consumption, netting, or overpayment-to-advance conversion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Keeps funding traceable and makes accidental over-consumption a conflict.                                                                                                                                                                                                                                                                                      |
| What if USD payment and invoice rates differ (same currency)? | Preserve both snapshots; record the settlement exchange difference separately from cash and inventory as a purely informational figure (transaction-design.md §5). Do not revalue open debt or advances using today's rate.                                                                                                                                                                                                                                                                                                                                                                                                                                              | Special case of the cross-currency rule above where `settlementCurrency = debtCurrency`: the debt reduces by the exact nominal amount paid, with no rate involved in the reduction itself.                                                                                                                                                                     |
| Can cash go negative?                                         | Reject spending beyond the project's recorded balance in that original currency, including cancellation of income that would overdraw it. Opening cash uses an audited opening adjustment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Conservative default; never infer USD availability from a UZS reporting balance. Borrowing and cash exchange are not implied.                                                                                                                                                                                                                                  |
| What is cancellation?                                         | Correction of an erroneous posting, requiring a reason. Real supplier returns and actual cash refunds are distinct business actions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Reversing a record does not prove goods or money were physically returned. Only erroneous recorded effects can be corrected together.                                                                                                                                                                                                                          |
| Can old inventory operations be cancelled?                    | Only after all still-effective later movements on the affected balances and later supplier settlements have been reversed (section 7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Prevents a correction from changing historical write-off cost or making an arbitrary quantity/value subtraction.                                                                                                                                                                                                                                               |
| Can operations be backdated?                                  | Keep user `occurredOn` as a business date, plus server `postedAt` and a project posting sequence. Inventory costing and dependency order use posting order. Reject future business dates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Late entry is visible; it does not recost previous consumption. Reports expose both dates.                                                                                                                                                                                                                                                                     |
| What timezone defines a date?                                 | Project timezone, default `Asia/Samarkand`; immutable after the first posting. Store business dates as PostgreSQL `date`, technical instants as UTC `timestamptz`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Defines day boundaries without using the server's timezone.                                                                                                                                                                                                                                                                                                    |
| What are quantity, price, and rounding rules?                 | Decimal strings with explicit precision and rounding rules in section 4. Quantity must be positive; supplied prices and invoice totals must be positive. No free receipt or unit conversion workflow in MVP.                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Prevents silent rounding and inconsistent units.                                                                                                                                                                                                                                                                                                               |
| What does minimum stock mean?                                 | Threshold applies separately to each active warehouse and active material. Missing balance is zero. Null threshold disables the warning; equality is not low stock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Makes the warehouse warning deterministic, including never-stocked materials.                                                                                                                                                                                                                                                                                  |
| Must write-offs have a location?                              | Require both building block and floor, and validate their relationship.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Keeps required consumption analytics complete. Non-floor construction consumption needs an explicit later extension.                                                                                                                                                                                                                                           |
| What may be edited or removed?                                | Descriptive master data may be edited or made inactive. Posted amounts, currencies, quantities, dates, locations, and rate snapshots require cancellation and replacement; comments and attachments may be edited with audit.                                                                                                                                                                                                                                                                                                                                                                                                                                            | Referenced materials cannot change unit or project; history cannot be moved between projects.                                                                                                                                                                                                                                                                  |
| Are global catalogs writable?                                 | Units and categories are project-owned rows, seeded with useful defaults; units are not an enum.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | A manager cannot alter another project's labels or measurements.                                                                                                                                                                                                                                                                                               |
| How is existing inventory introduced?                         | Audited opening receipt with explicit quantity and UZS acquisition value, allowed only on a balance with no prior movements.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | No direct balance edits, fictitious supplier invoice, or unexplained zero cost.                                                                                                                                                                                                                                                                                |

Cross-project dashboards, cash transfers between projects, employee management,
commercial returns, partial purchase cancellations, automatic currency conversion,
negative inventory, and Telegram notifications are outside MVP. Automatic rate
retrieval is optional; validated manual rate input is sufficient for MVP.

## 3. Invariants and sources of truth

Every project-owned foreign reference must resolve inside the same project. The
database enforces this through composite foreign keys, in addition to controller
guards and transactional service checks. IDs supplied in bodies do not override
the authenticated actor or route project.

| State             | Source of truth                                    | Invariant                                                                                   |
| ----------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Cash              | Signed `FinancialTransaction` ledger               | Original rows plus reversal rows determine balances; no mutable `Project.balance`           |
| Purchase          | `Purchase` + immutable `PurchaseItem` rows         | Total equals sum of item totals; receipt, settlement, ledger, audit commit together         |
| Supplier debt     | Purchases less effective settlement allocations    | Per purchase and original currency, `0 <= settled <= total`                                 |
| Supplier advances | Advance funding less effective advance allocations | Per advance lot, `0 <= used <= funded`; no blind supplier balance                           |
| Inventory         | Immutable `StockMovement` history                  | Per warehouse/material, sum of signed quantity and value equals `InventoryBalance`          |
| Average cost      | `InventoryBalance.quantity` and `valueUzs`         | Derived by division; never replace total value with a rounded average multiplied back       |
| Write-off cost    | Its posted movement                                | Quantity, unit cost snapshot, and total UZS cost remain fixed                               |
| Transfer          | Paired movements in one operation                  | Quantities and UZS values sum to zero across both warehouses; zero cash rows                |
| Cancellation      | Linked compensating rows                           | At most one reversal of an original; original records remain queryable                      |
| Critical audit    | Audit rows inside the business transaction         | No successful financial, supplier, purchase, transfer, or write-off operation without audit |

No public endpoint creates raw stock movements, balance overrides, arbitrary ledger
signs, or allocations. Those records are outputs of named workflows. Business
records and audit have restrictive deletion rules; an inactive parent stays readable
through its history and can be referenced during an authorized correction.

## 4. Money, valuation, and analytics meanings

Use Prisma Decimal for all monetary and quantity arithmetic and PostgreSQL numeric
for aggregates. JSON request/response values are decimal strings, including report
totals. Avoid `Number`, `parseFloat`, unary `+`, and JavaScript numeric operators on
money or quantities. Precision policy:

| Value                                               | Proposed storage | Rule                                                                   |
| --------------------------------------------------- | ---------------- | ---------------------------------------------------------------------- |
| Original cash/invoice amount, UZS equivalent        | `Decimal(24,2)`  | Inputs with more than 2 fractional digits are rejected                 |
| Quantity/minimum stock                              | `Decimal(24,6)`  | Inputs with more than 6 fractional digits are rejected                 |
| Unit price and USD/UZS snapshot                     | `Decimal(24,8)`  | Positive, at most 8 fractional digits                                  |
| Inventory carrying value and unit cost snapshot     | `Decimal(30,8)`  | Retain 8 decimal places for moving-cost operations                     |
| Settlement carrying amounts and exchange difference | `Decimal(24,2)`  | Allocation residue belongs to the final settlement of that lot/invoice |

Use decimal arithmetic precision of at least 80 significant digits. Reject input
or calculated totals outside the destination column's range before persistence.
Reject exponent notation, NaN, infinity, negative inputs, and zero where positivity
is required. Round calculated amounts half-up at explicit boundaries. Reversals
copy stored amounts and invert direction; they never independently round again.

For UZS, `exchangeRate = 1` and `amountUzs = amount`. For USD,
`amountUzs = round2(amount * exchangeRate)`. Store the used rate, source
(`MANUAL`/`PROVIDER`), optional quote ID, and override reason on the operation.
USD requires an explicit positive snapshot or a specifically selected stored quote;
it never silently selects today's rate. Each purchase item retains its original
quantity, price, line total, and allocated UZS line total.

Calculate each original invoice line as `round2(quantity * unitPrice)`, then sum
those stored line totals. Convert the whole invoice total once to UZS. Distribute
the converted value among lines using the largest fractional remainders: truncate
each exact converted line to 2 places, then assign remaining 0.01 increments by
descending fractional remainder, ties by stable line number. Thus item UZS totals
exactly sum to invoice UZS total. Do not trust client-supplied totals.

For a receipt, with existing quantity `Q`, value `V`, received quantity `q`, and
posted receipt value `v`, store `Q' = Q + q`, `V' = V + v`; display average
`V' / Q'`. The outbound-movement formula, including the mandatory hardcoded
full-depletion special case (`q = Q`), is defined once in
[transaction-design.md §6](transaction-design.md#6-inventory-receipt-and-write-off-formulas)
and not repeated here.

Supplier settlement allocations (payments and advance consumption applied to a
purchase) may now cross currencies — see the business-rule table in section 2 and
[ADR 0006](adr/0006-cross-currency-settlement-explicit-rate.md). The exact
`debtAmountSettled` derivation, the required `settlementExchangeRate` field, the
purely informational `exchangeDifferenceUzs` figure, and worked examples
(same-currency/different-rate, and genuine cross-currency such as a USD debt paid
in UZS) are defined once in
[transaction-design.md §5](transaction-design.md#5-settlement-allocation-cross-currency-settlement).
Partial allocations distribute each source's stored value proportionally; the last
allocation in an operation takes the exact residual so nominal totals reconcile
exactly, with the same largest-remainder discipline used for purchase item totals.

`cashBalanceUzs` is the sum of historical UZS-valued cash flows, not a current-rate
valuation of physical currency holdings. Return original-currency balances beside
it. Differing rates can make historical UZS net flows negative even if both nominal
cash balances are nonnegative; the spending check uses nominal balances.

`totalIncome` and `totalExpense` mean net recorded cash inflows and outflows by
original transaction classification, after reversals. Purchase cash payments,
advances, debt payments, and salaries are subsets of outflow, not additional totals
to add to it. `purchaseTotal` means acquisition value whether paid or not;
`materialConsumption` means issued inventory cost. Expose these separately, along
with settlement exchange differences, to avoid double-counting acquisition and
consumption as expenses. This is a management ledger, not a statutory accounting
or tax-reporting implementation.

## 5. Prisma design

[backend-data-model.md](backend-data-model.md) specifies the proposed
`prisma/schema.prisma` models, fields, relations, constraints, indexes, and migration
checks. It is a design, not a generated client or applied migration. Start Phase 1
by validating and implementing the foundation subset; add each business subset
with the phase that first uses it.

Use UUID primary keys, project IDs on project-owned tables, timestamped posted
operations, restrictive foreign keys, and soft archival of master data. Extra
models earn their place by securing a concrete invariant: refresh sessions,
operations/idempotency, settlement allocations, and write-off/transfer headers.
There are no repositories per model, duplicated domain entities, CQRS, event
sourcing infrastructure, or generalized workflow engine.

The researched baseline is the stable Prisma ORM 7 family, with exact compatible
CLI/client/adapter versions verified and locked in Phase 1. Do not install an
unqualified CLI or accidentally adopt a release candidate whose transaction or
migration interface differs. See the [version and transaction research](research/transaction-design.md)
for dated primary sources and required validation. PostgreSQL is required for all
transaction tests; SQLite and mocked Prisma are not substitutes.

## 6. Modules and transaction ownership

Use the requested feature-first layout. Controllers validate HTTP requests and
invoke services; services use Prisma directly. Workflow services own a complete
business transaction, while internal collaborators accept that transaction client.
An internal helper must not open an independent transaction or use the root client
for part of a workflow.

```text
src/
  modules/
    auth/                 login, refresh rotation, logout, current actor
    users/                safe user reads and operator provisioning support
    projects/             scoped projects and write authorization
    finances/             cash posting, metadata correction, reversal
    inventory/
      warehouses/         warehouse master data
      materials/          materials, categories, extensible units
      stock-movements/    receipts, costing, write-offs, transfers, reversals
    suppliers/            suppliers, payments, advances, settlement allocations
    purchases/            atomic purchase posting and cancellation
    construction/
      blocks/             project buildings
      floors/             levels within buildings
    currency/             immutable rate snapshots and manual input
    analytics/            project aggregates and dashboard
    reports/              XLSX query projections and streaming
    attachments/          file lifecycle and storage adapter
    audit/                transactional audit writer and scoped history
  common/
    decorators/ guards/ filters/ interceptors/ pipes/ enums/ constants/
  database/               PrismaModule, PrismaService, transaction retry helper
  config/                 validated environment configuration
```

| Module interface                                                  | Behavior hidden from callers                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `PurchasePostingService.create(actor, projectId, input, key)`     | Complete receipt, costing, settlement, cash posting, and audit transaction                  |
| `PurchasePostingService.cancel(actor, projectId, id, input, key)` | Dependency checks and all compensating records                                              |
| `InventoryOperationsService.writeOff/transfer/cancel(...)`        | Quantity/value checks, paired movements, snapshots, reversal order                          |
| `SupplierSettlementService.pay/createAdvance/cancel(...)`         | Original-currency allocation, carrying values, remaining debt/advance, cash and audit       |
| `FinancialPostingService.create/cancel/editComment(...)`          | Allowed cash kinds, balance checks, immutable monetary fields, audit                        |
| `Storage.put/open/delete(key, stream)`                            | Object storage details; local adapter for development, S3-compatible adapter for deployment |

Purchase workflow imports inventory, supplier, finance, and audit functionality;
these lower modules do not import purchases. Standalone finance cancellation rejects
a purchase/payment-owned transaction and directs the caller to its owning workflow.
Analytics and reports query explicit Prisma projections/SQL aggregations and share
metric definitions. Avoid service-to-service HTTP, event buses, or module cycles.

### Atomic purchase sequence

The complete 11-step algorithm (resolve references, validate, compute totals,
create purchase/items, post receipt movements, create settlement allocations,
verify cross-record equations, audit, commit-or-rollback-everything) is defined
once in [transaction-design.md §4](transaction-design.md#4-purchase-transaction-algorithm)
and not repeated here. Two worked numbers to keep the policy concrete: a
50,000,000 UZS invoice with 20,000,000 paid increases stock value by 50,000,000,
decreases cash by 20,000,000, and leaves 30,000,000 supplier debt. A 30,000,000
invoice funded by a 20,000,000 existing advance plus 10,000,000 cash leaves zero
debt and zero remaining advance — funding the advance already reduced cash
earlier, so consuming it must not reduce cash a second time.

## 7. Write-offs, transfers, and corrections

A write-off creates no cash transaction; a transfer creates no cash transaction.
Both validate their project-scoped references and current stock inside the same
transaction as the movement they post. The exact receipt/write-off/transfer
formulas (including the mandatory hardcoded full-depletion case) live in
[transaction-design.md §6–§7](transaction-design.md#6-inventory-receipt-and-write-off-formulas).

Posted operations transition from effective to cancelled exactly once; a
reversal is itself another posted operation linked to the original and can
never itself be reversed. A replacement is a new operation with a new
idempotency key, optionally linked through `replacementOfId`. Monetary and
quantity fields on a posted operation are immutable even after cancellation;
only metadata changes (comment, attachment) record previous/new values in place.

### Inventory cancellation algorithm

The effective-head dependency check, the exact inverse-movement construction,
and why popping a head is non-destructive (a later reversal can re-open an
earlier operation for cancellation) are defined once in
[transaction-design.md §8](transaction-design.md#8-cancellation--reversal-algorithm).

### Financial and supplier cancellation rules

Policy specific to standalone finance and supplier workflows, not covered by the
general algorithm above:

- Standalone financial cancellation creates an opposite-direction transaction of
  the original business type, linked through `reversalOfId`, with identical
  amount/currency/rate/UZS amount and category/recipient snapshots. The original
  and reversal are both included in cash aggregation — never exclude the
  original while including its inverse. Reversing income also checks nominal
  cash availability (an income reversal cannot overdraw the project).
- Purchase cancellation requires no unreversed later settlement allocation
  against that purchase (see the general algorithm). A paid purchase is
  cancellable only as a correction of the recorded receipt and payment; it is
  not a shortcut for an actual supplier return with an unpaid refund — those
  are distinct business actions per the domain glossary's `Refund` entry.
- Supplier payment cancellation reverses its allocations and actual cash
  outflow, reopening the associated debt. Supplier advance funding cancellation
  requires that every allocation consuming that advance has first been reversed.
- A generic `REFUND` records a real cash receipt against a standalone expense or
  salary only, limited to its unrefunded original-currency amount. Supplier or
  purchase refunds need their own stock/debt-aware workflow and are rejected by
  this generic path. A standalone expense with an effective refund cannot be
  cancelled until that refund is corrected; cancelling a refund itself checks
  available cash.
- Every conflict rolls back completely. There is no force-cancel override.

## 8. Concurrency and idempotency

The full locking protocol (project-row lock, lock/wait ordering, missing-row
caveat), the Serializable retry policy (retryable errors, attempt bound,
backoff, retry boundary), and the idempotency-key mechanism (storage, replay,
race handling) are defined once, with rationale, in
[transaction-design.md §1–§3](transaction-design.md#1-locking-strategy) and
[ADR 0003](adr/0003-single-project-lock-mvp.md) /
[ADR 0005](adr/0005-idempotency-key-required.md). Different projects proceed
fully independently; this consciously trades within-project write throughput
for a locking protocol simple enough to argue correct.

Database FK/unique/CHECK constraints are independent safeguards. Cross-row totals
are validated by named workflow services under this lock protocol, with narrowly
scoped deferred constraint triggers for ledger/projection and paired-transfer
consistency (data model). Raw SQL migrations and administrative tools must obey the
same protocol. Production application credentials have no schema-owner, truncate,
or history-deletion privileges. Database superuser access is outside application
authorization and is an operator responsibility.

Object storage, provider fetches, email, and notifications stay outside retryable
database callbacks. Prepare needed immutable inputs before posting. One connection
serves an interactive transaction, so use batched database queries rather than
assuming `Promise.all` accelerates its statements.

## 9. Authentication, authorization, and API contracts

Use JWT access tokens with a short configured lifetime (initially 15 minutes),
validated algorithm, issuer, audience, expiry, user ID and session ID. Load the
current active user/session for each authenticated request; trust database role
and assignment rather than stale token claims. Reject revoked or expired sessions.
Hash passwords with Argon2id using a maintained package and parameters verified
against its documentation in Phase 2; never store or log plaintext passwords.

Refresh tokens are opaque cryptographically random secrets (at least 32 random
bytes), stored only as SHA-256 hashes. Store session family, expiry, revocation,
consumption, and replacement IDs. Rotation atomically consumes one token and
issues its successor; reuse revokes the family, including the winner of concurrent
reuse. Clients must serialize refresh requests. Logout revokes the current family,
clears the cookie, and makes associated access tokens fail session checks. Revoke
sessions after password reset, deactivation, role change, or reassignment.

Browser refresh tokens use Secure, HttpOnly, SameSite cookies with a narrow auth
path in production; explicit local HTTP configuration is development-only. Validate
Origin and CSRF token on cookie-authenticated refresh/logout, configure exact CORS
origins, and return access tokens in the response body. Rate-limit login and
refresh, use a generic invalid-credentials response, and redact credentials,
tokens, cookies, and signed URLs from logs. Public endpoints are limited to auth
entrypoints, liveness, and deliberately configured documentation access.

Global Nest `ValidationPipe` uses `whitelist: true`,
`forbidNonWhitelisted: true`, and `transform: true`. Validate nested items, dates,
UUIDs, enums, strings, decimal strings, path/query parameters, file metadata, and
headers; require array limits, pagination limits, and bounded date ranges. Construct
Prisma data explicitly rather than spreading the request body. Date range inputs
are half-open `[from, to)` in business dates. Money is never implicitly transformed
to a JavaScript number.

Use explicit route capabilities (`read`, `write`, `export`); HTTP method alone is
insufficient because refresh/logout legitimately mutate authentication state for
read-only users. A manager's request for another project returns 403
`PROJECT_ACCESS_DENIED`. A nested resource missing inside an authorized project
returns 404 without revealing where it exists. For posted workflow input, use
generic project-mismatch codes without returning another project's details.
Service-level authorization runs even when a workflow is called without HTTP.

### Route surface

**Correction (Phase 3, 2026-09-14):** this section previously stated "all business
routes are beneath `/api/v1`" while the table below it already listed `/auth`,
`/users`, and `/projects` unprefixed — an internal inconsistency never caught
because no business route existed yet to expose it. Phase 1/2 already shipped
`/health` and `/auth/*` unprefixed, and Phase 3's own instructions for `/projects`
and its nested resources used the same unprefixed shape; retrofitting a global
`/api/v1` prefix now would break those without a real requirement driving it.
Resolved conservatively by matching what is actually implemented: there is no
global path prefix. `P` below means `/projects/:projectId`. Every collection is
paginated; detail/list DTOs expose only safe fields. Every POST/PATCH business
route is manager-only for that project.

| Route                                                                                                                 | Contract                                                                                      |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `POST /auth/login`, `/auth/refresh`, `/auth/logout`; `GET /auth/me`                                                   | Login, cookie rotation, revocation, safe current user                                         |
| `GET /users`                                                                                                          | Owner/accountant safe directory; manager receives only self; no public account administration |
| `GET /projects`, `GET /projects/:projectId`; `PATCH /projects/:projectId`                                             | Scoped list/detail and manager descriptive edits; provisioning uses operator CLI              |
| `GET P/dashboard`, `GET P/analytics`                                                                                  | Same defined project metrics with validated dates                                             |
| `GET/POST P/finances`; `GET/PATCH P/finances/:id`; `POST P/finances/:id/cancel`                                       | Standalone income, expense, salary, linked refund, opening adjustment; PATCH comment only     |
| `GET/POST P/transaction-categories`; `PATCH P/transaction-categories/:id`                                             | Project-owned classification and archival                                                     |
| `GET/POST P/warehouses`; `PATCH P/warehouses/:id`                                                                     | Master data and archival                                                                      |
| `GET/POST P/units`, `P/material-categories`, `P/materials`; `PATCH .../:id`                                           | Extensible units, categories, material master data and archival                               |
| `GET P/inventory`; `GET P/inventory/movements`; `POST P/inventory/opening-receipts`                                   | Quantity/value projections, immutable history, explicit opening stock                         |
| `POST/GET P/inventory/write-offs`, `P/inventory/transfers`; `POST .../:id/cancel`                                     | Audited stock workflows and guarded reversals                                                 |
| `GET/POST P/suppliers`; `GET/PATCH P/suppliers/:id`; `GET .../:id/statement`                                          | Supplier master data and separate debt/advance statement                                      |
| `POST/GET P/suppliers/:supplierId/payments`, `.../advances`; `POST .../:id/cancel`                                    | Explicit settlements and funding with original-currency allocations                           |
| `GET/POST P/purchases`; `GET/PATCH P/purchases/:id`; `POST .../:id/cancel`                                            | Atomic purchase workflow; PATCH comment only                                                  |
| `GET/POST P/construction/blocks`; `PATCH .../blocks/:id`                                                              | Building blocks and archival                                                                  |
| `GET/POST P/construction/blocks/:blockId/floors`; `PATCH .../floors/:id`                                              | Floors with validated block relationship                                                      |
| `GET/POST P/currency-rates`                                                                                           | Historical project quotes and append-only manual quote creation                               |
| `POST P/attachments`; `POST P/attachments/:id/finalize`; `GET P/attachments/:id/download`; `DELETE P/attachments/:id` | Stage, verify/link, protected download, audited soft unlink                                   |
| `GET P/audit`                                                                                                         | Project-filtered actor/action/entity history                                                  |
| `GET P/reports/:reportType`                                                                                           | Protected XLSX exports with matching metric/date semantics                                    |

Creation returns 201 after commit; read/metadata/cancellation returns 200; logout
returns 204. An idempotent replay returns 200 and identifies the existing operation.
Use an exception filter to return `{ code, message, requestId, details? }`. Map
400 validation, 401 authentication, 403 capability/project denial, 404 scoped missing
resource, 409 business conflict, 413 file too large, 415 unsupported media, and 429
throttling. Unexpected failures return generic 500; server logs retain sanitized
diagnostics. Never return Prisma messages, SQL, stack traces, credentials, or
cross-project IDs. Business error codes, aligned with the second specification's
exact naming, are the single set used across the API: `PROJECT_ACCESS_DENIED`,
`SUPPLIER_PROJECT_MISMATCH`, `WAREHOUSE_PROJECT_MISMATCH`,
`MATERIAL_PROJECT_MISMATCH`, `INSUFFICIENT_STOCK`, `INSUFFICIENT_CASH`,
`INVALID_ADVANCE_AMOUNT`, `ADVANCE_EXCEEDS_AVAILABLE`,
`DEBT_PAYMENT_EXCEEDS_REMAINING`, `SETTLEMENT_RATE_REQUIRED`,
`PURCHASE_ALREADY_CANCELLED`, `PURCHASE_HAS_DEPENDENT_MOVEMENTS`,
`CANCELLATION_HAS_DEPENDENCIES`, `CROSS_PROJECT_TRANSFER_FORBIDDEN`,
`IDEMPOTENCY_KEY_REUSED`, and `CONCURRENT_MODIFICATION`. `INVALID_ADVANCE_AMOUNT`
is the input-validation error (non-positive/malformed amount);
`ADVANCE_EXCEEDS_AVAILABLE` is the business conflict for over-consumption of an
existing lot — the two are distinct (400 vs 409). Include all of them in Swagger
examples; the full derivation of each is in
[transaction-design.md §10](transaction-design.md#10-error-catalog-referenced-by-this-document).

Swagger must describe bearer auth, refresh cookies/CSRF, role capabilities, decimal
strings, nested DTOs, query pagination/date semantics, idempotency, cancellation
restrictions, and error responses. Gate or disable interactive docs in production
through explicit configuration.

## 10. Audit and attachments

Audit records actor kind/user/operator identity, project, action, entity type/ID,
operation/request IDs, previous and new safe JSON data, and server timestamp.
Decimal snapshots are strings. Audit financial creation/comment edits/cancellation,
purchases/cancellation, supplier payments/advances/consumption/cancellation,
write-offs/transfers/reversals, attachments, and operator account/project changes.
The transactional writer arrives before the first financial posting in Phase 4;
Phase 9 completes the read interface and attachment integration. Successful audit
is not fire-and-forget. Authentication denial logging is separate from business
success audit and contains no secrets.

Attachment business links use real foreign keys to a purchase, financial
transaction, or supplier payment, with exactly one target and same-project checks.
Permit income/expense finance targets, purchase targets, and supplier payments.
Retain links and files with cancelled records. Storage keeps generated opaque keys
and private access; no client-supplied filesystem paths or remote URL fetching.

Provide a real local-filesystem development adapter and a real S3-compatible
deployment adapter behind the small storage interface. Supabase can use that
interface through a compatible adapter later. MVP permits JPEG, PNG, WebP and PDF,
up to a configured limit (initially 10 MiB); verify size, content signatures and
allowed media type, not just extension. Reject SVG/HTML and serve downloads with
safe disposition, content type, and `nosniff`.

Storage and PostgreSQL cannot share a transaction. Use staged uploads with
`PENDING -> READY -> LINKED` or `FAILED`, expiry, and an orphan cleanup job. Only a
verified existing object may be linked, inside a short authorized database
transaction with audit. Business posting need not wait for uploads; a failed upload
must not fabricate a successful attachment or roll back an already committed
purchase. Cleanup locks/rechecks attachment state before deleting unlinked objects.
Every upload, finalize, unlink, and download rechecks actor and target project.
Download uses an authorized stream or a short-lived signed URL; report/file access
must not become public through an object key.

## 11. Analytics and XLSX reports

All aggregation starts with one authorized project. Flow metrics use `occurredOn`
in `[from,to)`; cancellation takes effect on its own business date and does not
erase the original period. Return opening cash, period inflow/outflow, and closing
cash, where closing includes all ledger rows before `to`, not only period rows.
Return current balances separately when `to` is historical.

Supplier debt/advance as of `to` is reconstructed from original postings and their
dated reversal/settlement rows. A purchase cancelled after `to` remains an
obligation in that earlier report; do not filter historical reports by its current
cancelled status. Historical inventory value is the sum of movement value deltas
before `to`; current `InventoryBalance` is only for current inventory. Backdated
entries may restate business-date reports; return the generation time and posting
sequence cutoff to make this visible. No closed-period ledger is implied by MVP.

Required metrics are cash income/expense/balance, expenses by category, acquisition
purchases, salaries, supplier debt and advances, inventory value, and material
consumption by block and floor. Consumption aggregates original write-off costs
and their reversals, excluding transfers and purchase receipts. Classify reversals
under the original type/category. Preserve archived entities in historical joins.

Use database `SUM`, `GROUP BY`, Prisma aggregation, or parameterized SQL and mapped
Decimal results. Avoid row-by-row supplier balance calls and loading the entire
project into Node to total it. Take a consistent read-only transaction snapshot for
a multi-metric dashboard or export. Apply bounded range/page limits and an export
timeout; do not hold a project write lock while generating reports.

XLSX exports cover financial transactions, purchases (including items), suppliers,
debts, advances, inventory balances, stock movements, and material consumption by
block and floor. Include project, filters, generation instant, original currency,
historical rate, UZS value, original/reversal references, and cancellation state
where relevant. Each query uses the same authorization and metric definitions as
the REST view. Stream rows in bounded batches and honor HTTP backpressure; use
database aggregates for totals. Export exact decimal strings as text cells to
avoid losing precision in Excel numeric cells. User-controlled strings are text,
never formulas or external links; verify formula-like input in export tests.

## 12. Implementation phases and quality gates

Implement in the requested sequence, with one complete observable workflow at a
time inside each phase. Do not generate all models/controllers/tests in one change.
Every phase begins by reading this document and its dependencies, writing a failing
behavior test for the next slice, then implementing that slice. Review and pass
its gates before moving on. Earlier core transaction tests remain in the suite.

| Phase                    | Depends on                                  | Deliverable and required evidence                                                                                                                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0: design                | Existing starter and supplied specification | Repository/skill inventory, glossary, model, policies, module/REST interfaces, concurrency/security design, baseline checks and independent review                                                                                                                                                                |
| 1: foundation            | 0                                           | Validated config, pinned compatible dependencies, Jest migration, Prisma module/client, initial schema/migration, local/test PostgreSQL, shared bootstrap/validation/error filter, Swagger and health. Prove clean migration replay, database connectivity/failure handling, DTO rejection, and compiled startup. |
| 2: auth                  | 1                                           | User/project-assignment schema, secure seed/operator account setup, login, refresh rotation/reuse, logout/me, capability guards and transactional actor checks. Test all roles and stale/revoked credentials.                                                                                                     |
| 3: projects/construction | 2                                           | Scoped project reads/descriptive edits, operator provisioning, blocks/floors and archival. Test own-project mutation, foreign-project denial, floor/block mismatch and history retention.                                                                                                                         |
| 4: finances              | 3                                           | Currency snapshots, operation/idempotency infrastructure, audit writer, cash ledger, categories, income/expense/salary/opening adjustment/refund, comment edits and cancellation. Test original-currency cash sufficiency, fixed rates, reversals, audit rollback and duplicate requests.                         |
| 5: inventory masters     | 4                                           | Warehouses, project units/categories/materials, balance/movement schema, low stock, opening receipt and cost primitive. Test unique balance, no negative values, exact receipt/depletion, zero-balance warning and unit immutability.                                                                             |
| 6: suppliers             | 5                                           | Supplier master data, payment/advance/allocation schema, advance funding/cancellation and statement queries. Prepare purchase-linked settlement logic with database fixtures; debt creation through the public API arrives in Phase 7, not a mock purchase endpoint.                                              |
| 7: purchases             | 6                                           | Multi-item atomic purchases, full/partial/unpaid funding, advances/mixed funding, moving average, debt payment, cancellation and replacement. Verify every linked state and late-failure rollback on PostgreSQL.                                                                                                  |
| 8: inventory operations  | 7                                           | Write-off, atomic transfer and cancellation with effective-head dependency checks. Verify block/floor costing, insufficient stock, failed destination, dependent cancellation and transfer conservation.                                                                                                          |
| 9: audit/attachments     | 8                                           | Complete scoped audit reads, safe metadata snapshots, real local/S3 attachment adapters, private downloads, verification/linking/cleanup. Test provider failure, orphan cleanup races, MIME/size validation and role/project access.                                                                              |
| 10: analytics            | 9                                           | Required database aggregates, date filtering, historical versus current balances and dashboard. Verify reconciled totals, late entry, archived joins and cancellation across reporting periods.                                                                                                                   |
| 11: reports              | 10                                          | All required XLSX exports with exact decimals, filters and access control. Parse generated workbooks to verify rows, totals, dates, media/headers, text safety, and bounded export behavior.                                                                                                                      |
| 12: complete test suite  | 11                                          | Expand existing critical tests with deterministic concurrency barriers, replay/error races, precision limits, revocation, tenant isolation, migration/schema constraints and reconciliation. No skipped required cases or mocked Prisma.                                                                          |
| 13: final review         | 12                                          | Independent standards/spec review and fixes: money, authorization, transaction ownership, decimal arithmetic, indexes/query plans, N+1 reads, unsafe deletes and deployment docs. All gates rerun after fixes; no release while any required check fails.                                                         |

Database model ordering needs small prerequisite adjustments: create a minimal
Project table in Phase 1/2 for a manager's foreign key, audit support in Phase 4,
and purchase/allocation tables in Phase 6 when required for relational integrity.
These do not expose later-phase APIs early. Each migration remains independently
replayable and every phase has useful verified behavior.

### Test strategy and mandatory scenarios

Use Jest and Nest testing utilities through the real REST application for
authentication, project security, and posting workflows. Use real PostgreSQL,
the production isolation settings, and applied migrations. Read resulting state
through API responses; use direct database assertions for rollback, immutable
history, constraints, and reconciliation where the HTTP projection cannot prove
the invariant. This database verification is expressly required by the financial
specification. Mock only external storage/provider boundaries when testing failure
handling; do not mock Prisma for critical workflows.

| Area                 | Minimum acceptance scenarios                                                                                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth/access          | Valid/invalid login; owner/accountant write rejection; manager own-project success/other-project denial; nested foreign IDs; refresh rotation/reuse/concurrency, logout, expired/revoked/inactive user, changed assignment, CSRF and report/file access                                                            |
| Purchases            | Full/partial/unpaid; advance-only; mixed advance/cash; 50m/20m and 30m/20m/10m specification examples; multi-item totals; invalid supplier/warehouse/material/currency; audit or constraint failure after inventory writes rolls everything back                                                                   |
| Supplier obligations | Debt creation/payment; overpayment rejection; advance creation/consumption/over-consumption; explicit lot allocation, partial and final carrying-value residue; different USD rates; cancellations restore exact obligations                                                                                       |
| Inventory            | Receipt; weighted average `100*70000 + 200*80000 = 23000000` over 300 units; write-off and fixed historic cost after later purchase; insufficient stock; complete depletion leaves exact zero value; paired transfer and rollback; opening stock and low-stock missing rows                                        |
| Cancellation         | Original finance retained and exactly reversed; duplicate cancellation; purchase restores stock/cash/debt/advances; dependent later movement/payment blocks; reverse dependent operation then original; transfer requires both heads; original period versus reversal period                                       |
| Currency/precision   | UZS rate 1; USD 1000 at 12500 yields 12500000 UZS; changing quote does not change history; invoice rounding allocation; many fractional issues reconcile; out-of-range/excess-scale rejection; no JavaScript-number serialization                                                                                  |
| Audit/files/reports  | Audit action/actor/project/old-new fields; no success audit on rollback; attachment scope/MIME/size/provider failure; every XLSX type and access rule; no formula injection; aggregate/query result reconciliation                                                                                                 |
| Concurrency          | Two write-offs exceeding stock jointly: only feasible one commits; two first receipts: one balance with both values; two advance consumers: no overuse; opposite transfers: conserved stock/value; duplicate purchase keys: one operation; cancellation vs consumption; payment vs cancellation; refresh vs logout |

Run concurrent cases on separate PostgreSQL connections/processes with deterministic
synchronization barriers, not timing sleeps. Assert committed outcomes plus absence
of partial effects. Configure a dedicated test database/schema per worker; require
an explicit test URL, reject production targets, apply migrations before testing,
and restrict cleanup to the created test scope. Also test constraints directly,
including attempted wrong-project FK, negative stock, duplicate balance and second
reversal. Add narrowly scoped unit tests for rounding/valuation and policy functions
using independent literal expectations. Do not add tests that only mirror code.

### Gates, setup, and operational documentation

Before each implementation phase is complete: format changed files, run lint with
no suppressed rules, typecheck application and tests, build, run unit tests and all
applicable PostgreSQL integration/e2e tests, and inspect the diff. Validate/generate
Prisma and replay migrations when the schema changes. A build that excludes tests
does not replace whole-project type checking. Missing database access is a blocked
gate, not a skipped passing suite. Phase 0's baseline commands/results are recorded
separately because no business workflows exist yet.

Phase 1 must add actual scripts for `typecheck`, `format:check`, `test:integration`,
schema validation/generation, migration development/deployment, and seeding, while
preserving normal build/run scripts. Configure CI with real PostgreSQL and those
same gates. Select a supported Node LTS and PostgreSQL release and pin them after
compatibility verification; the current local Node 26 runtime is an observation,
not a deployment requirement.

Maintain README as implementation lands: local prerequisites and clean install,
environment setup, PostgreSQL/Compose startup, Prisma client generation and
reviewed migration workflow, idempotent seed/operator provisioning, development
and compiled production startup, Swagger, test database safety, and all gate
commands. Document required environment names for database/test database URLs,
JWT secret/issuer/audience/TTLs, CORS/cookie/CSRF settings, application port/timezone,
transaction/pool limits, storage adapter/bucket/endpoint/credentials, file limits,
and optional provider/telemetry configuration. Real secrets never enter examples.

Seeds create example projects, units, categories, and accounts only through an
explicit development/test workflow with supplied passwords; no default production
credentials or fictitious production balances. Operators bootstrap production
through a separate audited command. Migrations use a separate DDL-capable account;
the application account has least-privilege data access. Document encrypted backups,
restore verification, database readiness, graceful pool shutdown, and sanitized
request/conflict logs as operational requirements before deployment.
