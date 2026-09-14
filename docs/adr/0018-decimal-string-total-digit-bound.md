---
status: accepted
---

# `IsDecimalString` bounds total significant digits, not just the fractional scale

Phase 12's production-hardening pass tested what happens when a client submits a
decimal string with more INTEGER digits than its destination column allows — e.g.
`amount: "999999999999999999999999999999.00"` against `FinancialTransaction.amount
Decimal(24,2)`. Before this change, `IsDecimalString` only bounded the fractional
part's length (`maxDecimalPlaces`); the integer part was `[1-9]\d*`, unbounded. The
oversized value passed DTO validation, reached PostgreSQL inside the project-locked
transaction, and failed there with a raw `numeric field overflow` — caught generically
by `AllExceptionsFilter`'s Prisma-error fallback and surfaced as `500 DATABASE_ERROR`.
No stack trace or SQL leaked (the filter's generic fallback already prevents that), but
the status code and code were wrong: this is a client input-validation failure, not a
server fault, and it should never have reached the database at all.

**Decision:** add an optional `maxTotalDigits` to `DecimalStringOptions`, defaulting to
`24`. Every `@IsDecimalString`-validated field in this schema maps to a `Decimal(24, N)`
column (money/rate fields at `Decimal(24,2)`/`Decimal(24,8)`, quantity fields at
`Decimal(24,6)`) — confirmed by checking all 18 call sites — so the single default
correctly covers every existing use with zero call-site changes. The regex now bounds
the integer part to `maxTotalDigits - maxDecimalPlaces` digits, rejecting the oversized
case at the DTO layer with a clean `400 VALIDATION_ERROR` instead.

**Why not bound it per call site instead:** every current field already happens to
share the same 24-digit total precision, so a mandatory per-call-site parameter would
have meant touching 18 files for no behavioral difference from the shared default — pure
churn. The parameter still exists and is honored (see the validator's own test suite)
for the day a genuinely different precision is added; a future `Decimal(30, 8)` field
accepting direct client input (none exists yet — Phase 5-8's own carrying-value columns
are always server-computed, never client-supplied) would pass `maxTotalDigits: 30`
explicitly rather than silently reusing an incorrect default.

**Verification:** confirmed empirically (not just reasoned about) — reproduced the raw
`500` first, then reproduced the fix's `400` against the real Prisma/PostgreSQL stack,
per this project's own "prove it against real PostgreSQL, never assume" testing
discipline. Regression test: `test/finances.e2e-spec.ts` ("rejects an amount with more
integer digits than its Decimal(24,2) column allows...").
