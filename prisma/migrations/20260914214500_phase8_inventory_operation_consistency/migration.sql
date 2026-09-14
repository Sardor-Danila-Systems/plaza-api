-- Phase 8 hardening: workflow transactions already create write-off and
-- transfer movements atomically, but composite FKs alone cannot prove that
-- the linked movement(s) match their header. These deferred constraint
-- triggers validate the final transaction state, so headers may be inserted
-- before their movement rows while a partial or mismatched operation can
-- never commit.

CREATE FUNCTION validate_stock_write_off_movements(p_write_off_id UUID) RETURNS VOID AS $$
DECLARE
  header "StockWriteOff"%ROWTYPE;
  reversal_operation_id UUID;
  original_count BIGINT;
  reversal_count BIGINT;
BEGIN
  SELECT * INTO header FROM "StockWriteOff" WHERE id = p_write_off_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COUNT(*) INTO original_count
  FROM "StockMovement" movement
  WHERE movement."writeOffId" = header.id
    AND movement.type <> 'REVERSAL';

  IF original_count <> 1 OR NOT EXISTS (
    SELECT 1
    FROM "StockMovement" movement
    WHERE movement."writeOffId" = header.id
      AND movement."operationId" = header."operationId"
      AND movement."projectId" = header."projectId"
      AND movement."warehouseId" = header."warehouseId"
      AND movement."materialId" = header."materialId"
      AND movement.type = 'WRITE_OFF'
      AND movement.direction = 'OUT'
      AND movement.quantity = header.quantity
      AND movement."unitCostUzs" = header."unitCostUzs"
      AND movement."totalCostUzs" = header."totalCostUzs"
  ) THEN
    RAISE EXCEPTION 'StockWriteOff % must have exactly one matching WRITE_OFF movement', header.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT id INTO reversal_operation_id
  FROM "PostedOperation"
  WHERE "reversalOfId" = header."operationId";

  SELECT COUNT(*) INTO reversal_count
  FROM "StockMovement" movement
  WHERE movement."writeOffId" = header.id
    AND movement.type = 'REVERSAL';

  IF header."cancelledAt" IS NULL THEN
    IF reversal_count <> 0 OR reversal_operation_id IS NOT NULL THEN
      RAISE EXCEPTION 'StockWriteOff % has reversal state without cancellation', header.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF reversal_operation_id IS NULL OR reversal_count <> 1 OR NOT EXISTS (
    SELECT 1
    FROM "StockMovement" movement
    WHERE movement."writeOffId" = header.id
      AND movement."operationId" = reversal_operation_id
      AND movement."projectId" = header."projectId"
      AND movement."warehouseId" = header."warehouseId"
      AND movement."materialId" = header."materialId"
      AND movement.type = 'REVERSAL'
      AND movement.direction = 'IN'
      AND movement.quantity = header.quantity
      AND movement."unitCostUzs" = header."unitCostUzs"
      AND movement."totalCostUzs" = header."totalCostUzs"
  ) THEN
    RAISE EXCEPTION 'Cancelled StockWriteOff % must have exactly one matching reversal movement', header.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION stock_write_off_movement_consistency_trigger() RETURNS TRIGGER AS $$
BEGIN
  PERFORM validate_stock_write_off_movements(COALESCE(NEW.id, OLD.id));
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER stock_write_off_movement_consistency
  AFTER INSERT OR UPDATE ON "StockWriteOff"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION stock_write_off_movement_consistency_trigger();

CREATE FUNCTION stock_movement_write_off_consistency_trigger() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."writeOffId" IS NOT NULL THEN
    PERFORM validate_stock_write_off_movements(NEW."writeOffId");
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER stock_movement_write_off_consistency
  AFTER INSERT ON "StockMovement"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION stock_movement_write_off_consistency_trigger();

CREATE FUNCTION validate_warehouse_transfer_movements(p_transfer_id UUID) RETURNS VOID AS $$
DECLARE
  header "WarehouseTransfer"%ROWTYPE;
  reversal_operation_id UUID;
  original_count BIGINT;
  reversal_count BIGINT;
BEGIN
  SELECT * INTO header FROM "WarehouseTransfer" WHERE id = p_transfer_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COUNT(*) INTO original_count
  FROM "StockMovement" movement
  WHERE movement."transferId" = header.id
    AND movement.type <> 'REVERSAL';

  IF original_count <> 2 OR NOT EXISTS (
    SELECT 1
    FROM "StockMovement" movement
    WHERE movement."transferId" = header.id
      AND movement."operationId" = header."operationId"
      AND movement."projectId" = header."projectId"
      AND movement."warehouseId" = header."sourceWarehouseId"
      AND movement."materialId" = header."materialId"
      AND movement.type = 'TRANSFER_OUT'
      AND movement.direction = 'OUT'
      AND movement.quantity = header.quantity
      AND movement."unitCostUzs" = header."unitCostUzs"
      AND movement."totalCostUzs" = header."totalCostUzs"
  ) OR NOT EXISTS (
    SELECT 1
    FROM "StockMovement" movement
    WHERE movement."transferId" = header.id
      AND movement."operationId" = header."operationId"
      AND movement."projectId" = header."projectId"
      AND movement."warehouseId" = header."destinationWarehouseId"
      AND movement."materialId" = header."materialId"
      AND movement.type = 'TRANSFER_IN'
      AND movement.direction = 'IN'
      AND movement.quantity = header.quantity
      AND movement."unitCostUzs" = header."unitCostUzs"
      AND movement."totalCostUzs" = header."totalCostUzs"
  ) THEN
    RAISE EXCEPTION 'WarehouseTransfer % must have exactly two matching opposite movements', header.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT id INTO reversal_operation_id
  FROM "PostedOperation"
  WHERE "reversalOfId" = header."operationId";

  SELECT COUNT(*) INTO reversal_count
  FROM "StockMovement" movement
  WHERE movement."transferId" = header.id
    AND movement.type = 'REVERSAL';

  IF header."cancelledAt" IS NULL THEN
    IF reversal_count <> 0 OR reversal_operation_id IS NOT NULL THEN
      RAISE EXCEPTION 'WarehouseTransfer % has reversal state without cancellation', header.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF reversal_operation_id IS NULL OR reversal_count <> 2 OR NOT EXISTS (
    SELECT 1
    FROM "StockMovement" movement
    WHERE movement."transferId" = header.id
      AND movement."operationId" = reversal_operation_id
      AND movement."projectId" = header."projectId"
      AND movement."warehouseId" = header."sourceWarehouseId"
      AND movement."materialId" = header."materialId"
      AND movement.type = 'REVERSAL'
      AND movement.direction = 'IN'
      AND movement.quantity = header.quantity
      AND movement."unitCostUzs" = header."unitCostUzs"
      AND movement."totalCostUzs" = header."totalCostUzs"
  ) OR header."cancelledAt" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "StockMovement" movement
    WHERE movement."transferId" = header.id
      AND movement."operationId" = reversal_operation_id
      AND movement."projectId" = header."projectId"
      AND movement."warehouseId" = header."destinationWarehouseId"
      AND movement."materialId" = header."materialId"
      AND movement.type = 'REVERSAL'
      AND movement.direction = 'OUT'
      AND movement.quantity = header.quantity
      AND movement."unitCostUzs" = header."unitCostUzs"
      AND movement."totalCostUzs" = header."totalCostUzs"
  ) THEN
    RAISE EXCEPTION 'Cancelled WarehouseTransfer % must have exactly two matching inverse movements', header.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION warehouse_transfer_movement_consistency_trigger() RETURNS TRIGGER AS $$
BEGIN
  PERFORM validate_warehouse_transfer_movements(COALESCE(NEW.id, OLD.id));
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER warehouse_transfer_movement_consistency
  AFTER INSERT OR UPDATE ON "WarehouseTransfer"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION warehouse_transfer_movement_consistency_trigger();

CREATE FUNCTION stock_movement_transfer_consistency_trigger() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."transferId" IS NOT NULL THEN
    PERFORM validate_warehouse_transfer_movements(NEW."transferId");
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER stock_movement_transfer_consistency
  AFTER INSERT ON "StockMovement"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION stock_movement_transfer_consistency_trigger();
