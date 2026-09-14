---
status: accepted
---

# Phase 4 adds a minimal transactional audit writer, not the full audit module

docs/backend-architecture.md §10 states that "the transactional writer arrives before the first
financial posting in Phase 4," and docs/transaction-design.md's invariant #23 requires that no
successful financial operation exist without a matching audit row. Phase 4 is the first phase with
any financial posting at all, so this requirement became concrete here — but the Phase 4 work
instructions received for this phase enumerated only currency/FinancialTransaction/income/expense/
salary as owned scope, with no explicit mention of an `AuditLog` table or writer. This was a genuine
conflict between the approved architecture and the phase's stated scope, not a detail either
document was silent on, so it was surfaced and resolved with an explicit choice rather than picked
silently: add the minimal audit writer this phase, deferring only what §10 itself already defers to
Phase 9 (the `GET P/audit` read endpoint and attachment integration).

What exists now: an `AuditLog` model (project/actor/action/entityType/entityId/operationId/
requestId/previousData/newData/createdAt), append-only (a database trigger rejects any `UPDATE`,
the same posture as `CurrencyRate`), and `AuditService.record(tx, ...)` — a single method that
writes one row using the *same* transaction client as the business write it documents, so a failed
audit insert rolls back the business effect with it (ordinary Prisma transaction atomicity, not a
separate deferred-constraint trigger verifying a matching row at commit — invariant #23 describes
that as one possible enforcement mechanism, not the only one, and the simpler mechanism gives the
same guarantee here). `FinancialPostingService` calls it for every create, cancel, and comment edit.

What deliberately does not exist yet: no `GET P/audit` endpoint (nothing reads these rows over HTTP),
no attachment linkage, and no audit calls added retroactively to Phase 2/3's authentication or
project-provisioning code paths — this ADR's scope is exactly "what Phase 4's own financial posting
needs to satisfy invariant #23," not a general audit-module rollout. Widening it to cover
provisioning/auth would have been scope creep beyond what was asked, introduced without the same
explicit confirmation this specific gap received.

**Why this shape and not a fuller module:** building the read side and attachment integration now
would anticipate Phase 9's design before that phase has been specified, duplicating effort if Phase
9's actual requirements differ from a guess made here. Building nothing at all would leave every
Phase 4 financial operation without the audit trail the approved architecture explicitly requires
before this exact point, which is a correctness gap in the approved design, not a stylistic
preference. The minimal writer satisfies the concrete, dated requirement without pre-building a
module whose full shape isn't specified yet.
