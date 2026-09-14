-- Hand-written (Prisma's schema language has no trigger support, see
-- docs/adr/0008-manual-sql-check-constraints.md's established pattern):
-- an audit trail that could itself be edited after the fact would not be an
-- audit trail. `AuditLog` has no update workflow at all, by design — same
-- shape as the CurrencyRate append-only trigger from the
-- phase4_immutability_triggers migration.
CREATE FUNCTION audit_log_prevent_update() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog % is append-only and cannot be modified', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_prevent_update
  BEFORE UPDATE ON "AuditLog"
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_prevent_update();
