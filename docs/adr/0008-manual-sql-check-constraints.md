---
status: accepted
---

# Cross-column CHECK constraints are added by hand to migration SQL

Prisma ORM v7's schema language has no native way to express a conditional CHECK constraint
(verified: `@@check(...)` is not valid Prisma syntax — `prisma validate` rejects it outright). The
approved data model requires exactly this for `User`: a `PROJECT_MANAGER` must have a `projectId`,
and no other role may have one. Rather than pushing this rule into application code only (where a
future direct-SQL script, a bug in one service method, or an admin tool could silently violate it),
we add the CHECK constraint by hand to the generated migration's SQL file immediately after running
`prisma migrate dev`, and keep it there through every subsequent migration. This matches the
approach docs/backend-data-model.md's "Constraint and migration acceptance matrix" already
prescribed for cases Prisma can't express natively. The cost is a manual, reviewed edit on every
migration that touches this constraint's columns; the alternative (trusting application code alone)
is exactly the kind of invariant this system's whole design philosophy rejects.
