import { Injectable } from '@nestjs/common';
import { PrismaTx } from '../../database/project-lock.service.js';
import { Prisma } from '../../generated/prisma/client.js';

export interface RecordAuditEntryInput {
  projectId: string;
  actorId: string;
  /** e.g. "financial_transaction.create" — see `AuditLog.action`'s doc
   * comment in schema.prisma. */
  action: string;
  entityType: string;
  entityId: string;
  operationId?: string;
  requestId?: string;
  /** Full prior-state snapshot (the entity's own safe response shape), or
   * `undefined` for a creation. */
  previousData?: Record<string, unknown>;
  /** Full post-write-state snapshot, same shape as `previousData`. */
  newData: Record<string, unknown>;
}

/**
 * Round-trips a plain snapshot object through JSON so whatever is stored is
 * guaranteed valid JSON regardless of what a caller passed in — in
 * particular this turns any stray `Prisma.Decimal`/`Date` value into its
 * `.toJSON()` string form automatically (matching "Decimal snapshots are
 * strings", docs/backend-architecture.md §10) and drops `undefined`
 * properties, rather than relying on every call site to have already
 * pre-serialized every field correctly.
 */
function toJsonSafe(value: Record<string, unknown>): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

/**
 * The transactional audit writer docs/backend-architecture.md §10 requires
 * to exist before Phase 4's first financial posting (invariant #23: "no
 * successful financial... operation without audit"). Deliberately minimal —
 * a writer only; `GET P/audit` and attachment integration are Phase 9's job.
 *
 * `record` takes the SAME `tx` the caller's business writes already ran
 * inside (never opens its own transaction — docs/backend-architecture.md
 * §6's "an internal helper must not open an independent transaction"), so a
 * failed audit insert rolls back the business effect it was meant to
 * record, and a successful one commits atomically with it. There is no
 * fire-and-forget path.
 */
@Injectable()
export class AuditService {
  async record(tx: PrismaTx, input: RecordAuditEntryInput): Promise<void> {
    await tx.auditLog.create({
      data: {
        projectId: input.projectId,
        actorId: input.actorId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        operationId: input.operationId,
        requestId: input.requestId,
        // Prisma.JsonNull (not plain `null`/`undefined`) is required to
        // store an actual SQL NULL in a nullable Json column.
        previousData: input.previousData
          ? toJsonSafe(input.previousData)
          : Prisma.JsonNull,
        newData: toJsonSafe(input.newData),
      },
    });
  }
}
