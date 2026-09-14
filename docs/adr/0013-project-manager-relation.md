---
status: accepted
---

# Project-manager assignment: `User.projectId` remains the sole source of truth; reassignment works by deactivation, never by nulling history

Phase 2 already established `User.projectId` (nullable FK, required iff `role = PROJECT_MANAGER`)
as the relation between a manager and their project. Phase 3 adds a second requirement — "one
project has exactly one active PROJECT_MANAGER" — which could have been enforced by adding a new
`Project.managerId` column instead. We did not: storing both `Project.managerId` and
`User.projectId` would be two sources of truth for the same fact, requiring them to be kept in sync
on every assignment/reassignment/role-change, exactly the redundancy the Phase 3 instructions warn
against. Instead we add a single hand-written partial unique index —
`CREATE UNIQUE INDEX ... ON "User" ("projectId") WHERE role = 'PROJECT_MANAGER' AND "isActive" =
true` (Prisma v7 supports partial indexes only behind the `partialIndexes` preview feature, which
this project avoids per its general stable-Prisma-only posture; hand-written like ADR 0008's CHECK
constraints) — which enforces "at most one active manager" on the _existing_ authoritative column
without introducing a second one.

The partial index is deliberately filtered on `isActive`, not a plain unique constraint on
`projectId`: a plain constraint would also forbid a **deactivated** former manager from keeping
their historical `projectId`, which is required by the forward-only-history rule (a reassignment
must not rewrite who used to manage a project). Reassignment therefore has a specific, deliberate
shape: deactivate the outgoing manager's `User` row (keeping their `role` and `projectId` exactly
as they were, for history) and activate the incoming manager's `User` row with that `projectId`, in
that order, inside one transaction. This is not a workaround — it composes directly with Phase 2's
existing `isActive` check in `JwtAuthGuard` (docs/adr/0009), so an outgoing manager's already-issued
access token stops granting project access on their very next request with zero new mechanism.
