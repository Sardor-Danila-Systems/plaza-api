-- Phase 9 — Attachments (docs/backend-architecture.md §10).
-- Generated via `prisma migrate diff` then hand-edited to add the CHECK
-- constraints and immutability/deletion triggers Prisma's schema language
-- cannot express (docs/adr/0008-manual-sql-check-constraints.md), the same
-- discipline as every prior migration in this project.

-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM ('PENDING', 'READY', 'LINKED', 'FAILED');

-- CreateTable
CREATE TABLE "Attachment" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "status" "AttachmentStatus" NOT NULL DEFAULT 'PENDING',
    "storageKey" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMPTZ(6),
    "linkedAt" TIMESTAMPTZ(6),
    "failedAt" TIMESTAMPTZ(6),
    "failureReason" TEXT,
    "expiresAt" TIMESTAMPTZ(6),
    "purchaseId" UUID,
    "financialTransactionId" UUID,
    "supplierPaymentId" UUID,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id"),
    -- Hand-added (docs/adr/0008): Prisma's schema language cannot express
    -- these cross-column conditional constraints.
    CONSTRAINT "Attachment_sizeBytes_positive_check" CHECK ("sizeBytes" > 0),
    CONSTRAINT "Attachment_originalFilename_length_check" CHECK (char_length("originalFilename") <= 255),
    -- "Exactly one target" (docs/backend-architecture.md §10) — only once
    -- LINKED; no target at all in every other status.
    CONSTRAINT "Attachment_target_xor_check" CHECK (
        ("status" <> 'LINKED' AND "purchaseId" IS NULL AND "financialTransactionId" IS NULL AND "supplierPaymentId" IS NULL)
        OR
        ("status" = 'LINKED' AND (
            (("purchaseId" IS NOT NULL)::int + ("financialTransactionId" IS NOT NULL)::int + ("supplierPaymentId" IS NOT NULL)::int) = 1
        ))
    ),
    -- Exactly the timestamp/reason fields implied by `status` are set.
    CONSTRAINT "Attachment_status_timestamps_check" CHECK (
        ("status" = 'PENDING' AND "readyAt" IS NULL AND "linkedAt" IS NULL AND "failedAt" IS NULL AND "failureReason" IS NULL)
        OR ("status" = 'READY' AND "readyAt" IS NOT NULL AND "linkedAt" IS NULL AND "failedAt" IS NULL AND "failureReason" IS NULL)
        OR ("status" = 'LINKED' AND "readyAt" IS NOT NULL AND "linkedAt" IS NOT NULL AND "failedAt" IS NULL AND "failureReason" IS NULL)
        OR ("status" = 'FAILED' AND "readyAt" IS NULL AND "linkedAt" IS NULL AND "failedAt" IS NOT NULL AND "failureReason" IS NOT NULL)
    ),
    -- A LINKED attachment is retained forever with its business record and
    -- is no longer an orphan-cleanup candidate.
    CONSTRAINT "Attachment_linked_no_expiry_check" CHECK ("status" <> 'LINKED' OR "expiresAt" IS NULL)
);

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_storageKey_key" ON "Attachment"("storageKey");

-- CreateIndex
CREATE INDEX "Attachment_projectId_status_idx" ON "Attachment"("projectId", "status");

-- CreateIndex
CREATE INDEX "Attachment_projectId_purchaseId_idx" ON "Attachment"("projectId", "purchaseId");

-- CreateIndex
CREATE INDEX "Attachment_projectId_financialTransactionId_idx" ON "Attachment"("projectId", "financialTransactionId");

-- CreateIndex
CREATE INDEX "Attachment_projectId_supplierPaymentId_idx" ON "Attachment"("projectId", "supplierPaymentId");

-- CreateIndex
CREATE INDEX "Attachment_status_expiresAt_idx" ON "Attachment"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_projectId_purchaseId_fkey" FOREIGN KEY ("projectId", "purchaseId") REFERENCES "Purchase"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_projectId_financialTransactionId_fkey" FOREIGN KEY ("projectId", "financialTransactionId") REFERENCES "FinancialTransaction"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_projectId_supplierPaymentId_fkey" FOREIGN KEY ("projectId", "supplierPaymentId") REFERENCES "SupplierPayment"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Immutability trigger: enforces the exact legal state-machine transitions
-- (PENDING -> READY | FAILED; READY -> LINKED; LINKED/FAILED terminal) and
-- that content/identity fields never change after insert.
CREATE FUNCTION attachment_prevent_illegal_update() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."projectId" IS DISTINCT FROM NEW."projectId"
    OR OLD."storageKey" IS DISTINCT FROM NEW."storageKey"
    OR OLD."originalFilename" IS DISTINCT FROM NEW."originalFilename"
    OR OLD."mimeType" IS DISTINCT FROM NEW."mimeType"
    OR OLD."sizeBytes" IS DISTINCT FROM NEW."sizeBytes"
    OR OLD."uploadedById" IS DISTINCT FROM NEW."uploadedById"
    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
  THEN
    RAISE EXCEPTION 'Attachment % content/identity fields are immutable', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD."status" IN ('LINKED', 'FAILED') THEN
    RAISE EXCEPTION 'Attachment % is in a terminal state and cannot be modified', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD."status" = 'PENDING' THEN
    IF NEW."status" NOT IN ('READY', 'FAILED') THEN
      RAISE EXCEPTION 'Attachment % illegal status transition from PENDING', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'READY' THEN
    IF NEW."status" <> 'LINKED' OR NEW."readyAt" IS DISTINCT FROM OLD."readyAt" THEN
      RAISE EXCEPTION 'Attachment % illegal status transition from READY', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER attachment_prevent_illegal_update
  BEFORE UPDATE ON "Attachment"
  FOR EACH ROW
  EXECUTE FUNCTION attachment_prevent_illegal_update();

-- A LINKED attachment's file and link are retained forever with the
-- business record it documents (docs/backend-architecture.md §10: "Retain
-- links and files with cancelled records") — hard deletion is only ever
-- legal for an orphan (PENDING/READY/FAILED, never linked to anything).
CREATE FUNCTION attachment_prevent_delete_when_linked() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" = 'LINKED' THEN
    RAISE EXCEPTION 'Attachment % is linked to a business record and cannot be deleted', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER attachment_prevent_delete_when_linked
  BEFORE DELETE ON "Attachment"
  FOR EACH ROW
  EXECUTE FUNCTION attachment_prevent_delete_when_linked();
