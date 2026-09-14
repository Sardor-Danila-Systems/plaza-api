import { PrismaTx } from '../../database/project-lock.service.js';
import { StockMovementType } from '../../generated/prisma/client.js';

/**
 * Every operation in this project that has ITSELF already been reversed
 * (its effect fully undone), keyed by the ORIGINAL operation's id — per
 * `PostedOperation.reversalOfId`'s own convention. Shared by every
 * cancellation workflow's dependency check (purchases, write-offs,
 * transfers) so a later movement/allocation that was only a transient
 * dependency (created and then cancelled again before this cancellation
 * ran) never wrongly blocks it. Compute once per cancellation call and pass
 * to `hasLaterEffectiveMovement`.
 */
export async function loadReversedOperationIds(
  tx: PrismaTx,
  projectId: string,
): Promise<Set<string>> {
  const rows = await tx.postedOperation.findMany({
    where: { projectId, reversalOfId: { not: null } },
    select: { reversalOfId: true },
  });
  return new Set(rows.map((row) => row.reversalOfId as string));
}

/**
 * transaction-design.md §8 step 2's dependency check, in this codebase's
 * simplified (operation-sequence-ordered) form rather than Phase 0's full
 * effective-head pointer chain (deferred — see this phase's own report): is
 * there a STILL-EFFECTIVE StockMovement for this exact (warehouse,
 * material) balance, posted by a strictly later operation than the one
 * being cancelled? A `REVERSAL`-type movement never itself counts (it only
 * undoes an effect, never creates a new dependency), and neither does an
 * original movement whose own operation was later reversed
 * (`reversedOperationIds`, from `loadReversedOperationIds`).
 */
export async function hasLaterEffectiveMovement(
  tx: PrismaTx,
  params: {
    projectId: string;
    warehouseId: string;
    materialId: string;
    afterSequence: bigint;
    reversedOperationIds: Set<string>;
  },
): Promise<boolean> {
  const candidates = await tx.stockMovement.findMany({
    where: {
      projectId: params.projectId,
      warehouseId: params.warehouseId,
      materialId: params.materialId,
      type: { not: StockMovementType.REVERSAL },
      operation: { sequence: { gt: params.afterSequence } },
    },
    select: { operationId: true },
  });
  return candidates.some(
    (movement) => !params.reversedOperationIds.has(movement.operationId),
  );
}
