---
status: accepted
---

# Detecting a retryable Serializable conflict from `$queryRaw` requires checking `meta.driverAdapterError.cause.kind`, not `.code` or `meta.code`

docs/transaction-design.md §2 requires retrying exactly two PostgreSQL conditions: a serialization
failure (`40001`) and a deadlock (`40P01`), both surfaced by Prisma's query-builder methods as the
single error code `P2034`. `ProjectLockService.runExclusive` additionally issues a raw
`SELECT ... FOR UPDATE` via `$queryRaw` to acquire the project lock (Prisma has no query-builder
equivalent for an explicit row lock), and a conflict detected there does **not** surface as `P2034` —
it surfaces as generic `P2010` ("raw query failed"). Two plausible-looking assumptions about where
the real SQLSTATE would then live were each tried and were each wrong:

- Assumed: the raw SQLSTATE appears directly on the error's own `.code` (i.e. `'40001'` instead of a
  `P`-prefixed code). Wrong — `.code` is always `'P2010'` for a raw-query failure, whatever the
  underlying database error was.
- Assumed: the SQLSTATE is nested one level down as `.meta.code`. Also wrong.

What actually happens, confirmed by deliberately forcing a real concurrent conflict against
PostgreSQL and printing the resulting error's exact shape (this project's concurrency test,
`test/finances-concurrency.e2e-spec.ts`, still forces this today so a future Prisma/adapter upgrade
that changes the shape again fails loudly instead of silently): `@prisma/adapter-pg` inspects the raw
PostgreSQL SQLSTATE itself and classifies both `40001` and `40P01` under one adapter-level category,
attached as `meta.driverAdapterError.cause.kind === 'TransactionWriteConflict'`. Prisma's own
error-code documentation does not describe this adapter-specific nesting; it was only discoverable by
producing the error and inspecting it directly, not by reading in advance.

The consequence of getting this wrong is not a crash — the wrong condition silently fails to be
recognized as retryable, so a real serialization conflict on the project-lock's own acquisition
propagates as a raw, unhandled 500 instead of being retried, defeating the reason `runExclusive`
exists at all. `isRetryableError` (`src/database/project-lock.service.ts`) checks both the
query-builder path (`code === 'P2034'`) and this raw-query path
(`code === 'P2010' && meta.driverAdapterError.cause.kind === 'TransactionWriteConflict'`) — anyone
changing this function should re-verify against a real forced conflict before trusting a
documentation-only description of Prisma's error shapes, per this project's general empirical-
verification discipline (see ADR 0007 for the earlier instance of the same lesson with Prisma's
client class identity).
