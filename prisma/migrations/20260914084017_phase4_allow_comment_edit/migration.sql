-- Correction: docs/backend-architecture.md's business-rules table ("What
-- may be edited or removed?") is explicit that "comments and attachments
-- may be edited with audit" even though "posted amounts, currencies,
-- quantities, dates, locations, and rate snapshots require cancellation and
-- replacement" — i.e. `comment` is deliberately NOT one of the immutable
-- fields, and stays editable even on an already-cancelled row (matching
-- `FinancialPostingService.editComment(...)`, docs/backend-architecture.md
-- §6's module interface table). The original phase4_immutability_triggers
-- migration blocked ANY update to a cancelled row, including `comment` —
-- this replaces that function with the corrected rule:
--   - `comment` may change at any time, cancelled or not.
--   - The three cancellation fields may be set together exactly once (NULL
--     -> non-null); once set, they too become immutable (no un-cancelling,
--     re-cancelling, or editing the recorded reason after the fact).
--   - Every other field is immutable from row creation onward, exactly as
--     before.
-- `CREATE OR REPLACE FUNCTION` keeps the existing trigger's binding to this
-- function name intact; no `DROP TRIGGER`/`CREATE TRIGGER` is needed.
CREATE OR REPLACE FUNCTION financial_transaction_prevent_illegal_update() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."cancelledAt" IS NOT NULL AND (
    NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt"
    OR NEW."cancellationReason" IS DISTINCT FROM OLD."cancellationReason"
    OR NEW."cancelledById" IS DISTINCT FROM OLD."cancelledById"
  ) THEN
    RAISE EXCEPTION 'FinancialTransaction % cancellation is final and cannot be changed', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD."projectId" IS DISTINCT FROM NEW."projectId"
    OR OLD."operationId" IS DISTINCT FROM NEW."operationId"
    OR OLD."type" IS DISTINCT FROM NEW."type"
    OR OLD."direction" IS DISTINCT FROM NEW."direction"
    OR OLD."amount" IS DISTINCT FROM NEW."amount"
    OR OLD."currency" IS DISTINCT FROM NEW."currency"
    OR OLD."exchangeRate" IS DISTINCT FROM NEW."exchangeRate"
    OR OLD."amountUzs" IS DISTINCT FROM NEW."amountUzs"
    OR OLD."rateSource" IS DISTINCT FROM NEW."rateSource"
    OR OLD."rateId" IS DISTINCT FROM NEW."rateId"
    OR OLD."rateOverrideReason" IS DISTINCT FROM NEW."rateOverrideReason"
    OR OLD."categoryId" IS DISTINCT FROM NEW."categoryId"
    OR OLD."categoryNameSnapshot" IS DISTINCT FROM NEW."categoryNameSnapshot"
    OR OLD."recipient" IS DISTINCT FROM NEW."recipient"
    OR OLD."occurredAt" IS DISTINCT FROM NEW."occurredAt"
    OR OLD."createdById" IS DISTINCT FROM NEW."createdById"
    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
    OR OLD."reversalOfId" IS DISTINCT FROM NEW."reversalOfId"
  THEN
    RAISE EXCEPTION 'FinancialTransaction % posted fields are immutable', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
