-- Hand-written (Prisma's schema language has no trigger support): this
-- migration implements docs/transaction-design.md's invariant #14
-- ("Historical FX immutable" / "no update endpoint for posted rate/amount
-- fields; a trigger denies UPDATE of posted monetary fields") for this
-- phase's ledger tables. See docs/adr/0008-manual-sql-check-constraints.md
-- for this project's established pattern of hand-written SQL where Prisma's
-- schema language cannot express the constraint.
--
-- FinancialTransaction: every posted field is immutable from creation
-- onward, with one narrow exception — the three cancellation fields may be
-- set together, exactly once, by the cancellation workflow. Once
-- "cancelledAt" is non-null the row becomes fully immutable, including
-- against a second cancellation attempt (a cancelled row is never
-- re-cancelled, mirroring "a reversal has no reversal" for
-- PostedOperation/FinancialTransaction.reversalOfId's own uniqueness).
CREATE FUNCTION financial_transaction_prevent_illegal_update() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."cancelledAt" IS NOT NULL THEN
    RAISE EXCEPTION 'FinancialTransaction % is cancelled and cannot be modified', OLD.id
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
    OR OLD."comment" IS DISTINCT FROM NEW."comment"
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

CREATE TRIGGER financial_transaction_prevent_illegal_update
  BEFORE UPDATE ON "FinancialTransaction"
  FOR EACH ROW
  EXECUTE FUNCTION financial_transaction_prevent_illegal_update();

-- PostedOperation: same shape as above, minus the fields FinancialTransaction
-- has and PostedOperation does not (no cancelledById on this table — the
-- actor performing a cancellation is captured by the *new* PostedOperation
-- their cancellation creates, linked via reversalOfId, not by mutating the
-- original).
CREATE FUNCTION posted_operation_prevent_illegal_update() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."cancelledAt" IS NOT NULL THEN
    RAISE EXCEPTION 'PostedOperation % is cancelled and cannot be modified', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD."projectId" IS DISTINCT FROM NEW."projectId"
    OR OLD."actorId" IS DISTINCT FROM NEW."actorId"
    OR OLD."kind" IS DISTINCT FROM NEW."kind"
    OR OLD."idempotencyKey" IS DISTINCT FROM NEW."idempotencyKey"
    OR OLD."requestHash" IS DISTINCT FROM NEW."requestHash"
    OR OLD."occurredAt" IS DISTINCT FROM NEW."occurredAt"
    OR OLD."postedAt" IS DISTINCT FROM NEW."postedAt"
    OR OLD."sequence" IS DISTINCT FROM NEW."sequence"
    OR OLD."reversalOfId" IS DISTINCT FROM NEW."reversalOfId"
  THEN
    RAISE EXCEPTION 'PostedOperation % posted fields are immutable', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER posted_operation_prevent_illegal_update
  BEFORE UPDATE ON "PostedOperation"
  FOR EACH ROW
  EXECUTE FUNCTION posted_operation_prevent_illegal_update();

-- CurrencyRate: genuinely append-only (see the model's own doc comment in
-- schema.prisma) — correcting a mistyped rate means inserting a new row, so
-- no legitimate UPDATE exists at all, not even a cancellation-style one.
CREATE FUNCTION currency_rate_prevent_update() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'CurrencyRate % is append-only and cannot be modified', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER currency_rate_prevent_update
  BEFORE UPDATE ON "CurrencyRate"
  FOR EACH ROW
  EXECUTE FUNCTION currency_rate_prevent_update();
