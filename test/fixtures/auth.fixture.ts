import { randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import request from 'supertest';
import {
  Currency,
  Prisma,
  PrismaClient,
  RateSource,
  Role,
  TransactionCategoryKind,
} from '../../src/generated/prisma/client.js';

/**
 * There is no POST /auth/register (docs/backend-architecture.md §9 — no
 * self-registration), so e2e tests create users directly through Prisma,
 * exactly as the real seed script does, against the real test database
 * (never a mocked Prisma client, per docs/backend-architecture.md §12).
 */
export interface TestUserOptions {
  role?: Role;
  isActive?: boolean;
  password?: string;
  projectId?: string | null;
}

export const TEST_PASSWORD = 'a-perfectly-fine-test-password-1';

export async function createTestUser(
  prisma: PrismaClient,
  options: TestUserOptions = {},
) {
  const passwordHash = await argon2.hash(options.password ?? TEST_PASSWORD, {
    type: argon2.argon2id,
  });
  return prisma.user.create({
    data: {
      email: `test-${randomUUID()}@example.com`,
      displayName: 'Test User',
      passwordHash,
      role: options.role ?? Role.OWNER,
      isActive: options.isActive ?? true,
      projectId: options.projectId ?? null,
    },
  });
}

export async function createTestProject(
  prisma: PrismaClient,
  name = 'Test Project',
) {
  return prisma.project.create({
    data: { name, code: `test-${randomUUID()}` },
  });
}

/** Deletes a user and everything referencing it, in FK-safe order (every FK
 * in this schema is RESTRICT, per docs/backend-data-model.md's convention —
 * see ADR 0001 and the schema header comment). Also sweeps any finance/audit
 * rows still referencing this user as a safety net for tests that touch more
 * than one project with the same user — `deleteTestProject` already handles
 * the common single-project case directly. */
export async function deleteTestUser(
  prisma: PrismaClient,
  userId: string,
): Promise<void> {
  const sessions = await prisma.refreshSession.findMany({
    where: { userId },
    select: { id: true },
  });
  const sessionIds = sessions.map((s) => s.id);
  if (sessionIds.length > 0) {
    // Break the self-referencing replacedById chain before deleting rows.
    await prisma.refreshToken.updateMany({
      where: { sessionId: { in: sessionIds } },
      data: { replacedById: null },
    });
    await prisma.refreshToken.deleteMany({
      where: { sessionId: { in: sessionIds } },
    });
    await prisma.refreshSession.deleteMany({ where: { userId } });
  }

  await prisma.auditLog.deleteMany({ where: { actorId: userId } });
  // Reversal rows (the referencing side of `reversalOfId`) are deleted
  // before the original rows they point back at — the immutability
  // triggers correctly reject nulling `reversalOfId` on an already-
  // cancelled row, so there is no update-then-delete path here, only
  // delete-in-dependency-order (see `deleteTestProject`'s doc comment).
  const userFilter = {
    OR: [{ createdById: userId }, { cancelledById: userId }],
  };
  // Attachment (Phase 9) references Project/User/Purchase/
  // FinancialTransaction/SupplierPayment, so it must be cleared first —
  // nothing else references an Attachment back.
  await prisma.attachment.deleteMany({ where: { uploadedById: userId } });
  await prisma.financialTransaction.deleteMany({
    where: { ...userFilter, reversalOfId: { not: null } },
  });
  await prisma.financialTransaction.deleteMany({ where: userFilter });
  // StockMovement (Phase 7/8) references PostedOperation, PurchaseItem,
  // StockWriteOff, and WarehouseTransfer, so it must be cleared before any
  // of those.
  await prisma.stockMovement.deleteMany({ where: { createdById: userId } });
  await prisma.stockWriteOff.deleteMany({ where: userFilter });
  await prisma.warehouseTransfer.deleteMany({ where: userFilter });
  await prisma.settlementAllocation.deleteMany({
    where: { createdById: userId, reversalOfId: { not: null } },
  });
  await prisma.settlementAllocation.deleteMany({
    where: { createdById: userId },
  });
  await prisma.purchaseItem.deleteMany({
    where: { purchase: userFilter },
  });
  await prisma.purchase.deleteMany({ where: userFilter });
  await prisma.supplierAdvance.deleteMany({
    where: { fundingPayment: { createdById: userId } },
  });
  await prisma.supplierPayment.deleteMany({ where: { createdById: userId } });
  await prisma.postedOperation.deleteMany({
    where: { actorId: userId, reversalOfId: { not: null } },
  });
  await prisma.postedOperation.deleteMany({ where: { actorId: userId } });
  await prisma.currencyRate.deleteMany({ where: { createdById: userId } });

  await prisma.user.delete({ where: { id: userId } });
}

export async function createTestBlock(
  prisma: PrismaClient,
  projectId: string,
  overrides: { name?: string; code?: string } = {},
) {
  const suffix = randomUUID();
  return prisma.buildingBlock.create({
    data: {
      projectId,
      name: overrides.name ?? `Test Block ${suffix}`,
      code: overrides.code ?? `test-block-${suffix}`,
    },
  });
}

export async function createTestFloor(
  prisma: PrismaClient,
  projectId: string,
  blockId: string,
  overrides: { label?: string; sortOrder?: number } = {},
) {
  const suffix = randomUUID();
  return prisma.floor.create({
    data: {
      projectId,
      blockId,
      label: overrides.label ?? `Test Floor ${suffix}`,
      sortOrder: overrides.sortOrder ?? 0,
    },
  });
}

export async function createTestCategory(
  prisma: PrismaClient,
  projectId: string,
  overrides: { name?: string; kind?: TransactionCategoryKind } = {},
) {
  const suffix = randomUUID();
  return prisma.transactionCategory.create({
    data: {
      projectId,
      name: overrides.name ?? `Test Category ${suffix}`,
      kind: overrides.kind ?? TransactionCategoryKind.EXPENSE,
    },
  });
}

export async function createTestCurrencyRate(
  prisma: PrismaClient,
  projectId: string,
  createdById: string,
  overrides: {
    rateUzs?: string;
    effectiveOn?: string;
    currency?: Currency;
  } = {},
) {
  return prisma.currencyRate.create({
    data: {
      projectId,
      currency: overrides.currency ?? Currency.USD,
      rateUzs: overrides.rateUzs ?? '12500.00000000',
      effectiveOn: new Date(
        `${overrides.effectiveOn ?? '2026-09-14'}T00:00:00.000Z`,
      ),
      source: RateSource.MANUAL,
      createdById,
    },
  });
}

export async function createTestUnit(
  prisma: PrismaClient,
  projectId: string,
  overrides: { symbol?: string; name?: string } = {},
) {
  const suffix = randomUUID();
  return prisma.unit.create({
    data: {
      projectId,
      symbol: overrides.symbol ?? `u-${suffix.slice(0, 8)}`,
      name: overrides.name ?? `Test Unit ${suffix}`,
    },
  });
}

export async function createTestMaterialCategory(
  prisma: PrismaClient,
  projectId: string,
  overrides: { name?: string } = {},
) {
  const suffix = randomUUID();
  return prisma.materialCategory.create({
    data: {
      projectId,
      name: overrides.name ?? `Test Material Category ${suffix}`,
    },
  });
}

export async function createTestWarehouse(
  prisma: PrismaClient,
  projectId: string,
  overrides: { name?: string; code?: string } = {},
) {
  const suffix = randomUUID();
  return prisma.warehouse.create({
    data: {
      projectId,
      name: overrides.name ?? `Test Warehouse ${suffix}`,
      code: overrides.code ?? `test-wh-${suffix}`,
    },
  });
}

export async function createTestMaterial(
  prisma: PrismaClient,
  projectId: string,
  categoryId: string,
  unitId: string,
  overrides: { name?: string; code?: string; minimumStock?: string } = {},
) {
  const suffix = randomUUID();
  return prisma.material.create({
    data: {
      projectId,
      categoryId,
      unitId,
      name: overrides.name ?? `Test Material ${suffix}`,
      code: overrides.code ?? `test-material-${suffix}`,
      minimumStock: overrides.minimumStock
        ? new Prisma.Decimal(overrides.minimumStock)
        : null,
    },
  });
}

export async function createTestInventoryBalance(
  prisma: PrismaClient,
  projectId: string,
  warehouseId: string,
  materialId: string,
  overrides: { quantity?: string; valueUzs?: string } = {},
) {
  return prisma.inventoryBalance.create({
    data: {
      projectId,
      warehouseId,
      materialId,
      quantity: overrides.quantity ?? '0',
      valueUzs: overrides.valueUzs ?? '0',
    },
  });
}

export async function createTestSupplier(
  prisma: PrismaClient,
  projectId: string,
  overrides: { name?: string; isActive?: boolean } = {},
) {
  const suffix = randomUUID();
  return prisma.supplier.create({
    data: {
      projectId,
      name: overrides.name ?? `Test Supplier ${suffix}`,
      isActive: overrides.isActive ?? true,
    },
  });
}

/**
 * Directly inserts a Purchase + PurchaseItem via Prisma, bypassing the
 * purchase-creation ORCHESTRATION workflow (Phase 7's job, not built yet —
 * see docs/adr's Phase 6 schema-only decision). This is the only way
 * Phase 6's debt-payment tests can have a real purchase debt to settle
 * against, matching the same "bypass the service, exercise the schema
 * directly" pattern already used for every other direct-DB test in this
 * codebase.
 */
export async function createTestPurchase(
  prisma: PrismaClient,
  projectId: string,
  supplierId: string,
  warehouseId: string,
  createdById: string,
  overrides: {
    currency?: Currency;
    exchangeRate?: string;
    totalAmount?: string;
    totalAmountUzs?: string;
    occurredAt?: string;
  } = {},
) {
  const currency = overrides.currency ?? Currency.UZS;
  const exchangeRate =
    overrides.exchangeRate ?? (currency === Currency.UZS ? '1' : undefined);
  const totalAmount = overrides.totalAmount ?? '30000000.00';
  const totalAmountUzs =
    overrides.totalAmountUzs ??
    (currency === Currency.UZS
      ? totalAmount
      : new Prisma.Decimal(totalAmount)
          .mul(new Prisma.Decimal(exchangeRate ?? '1'))
          .toFixed(2));

  const operation = await prisma.postedOperation.create({
    data: {
      projectId,
      actorId: createdById,
      kind: 'purchase.create',
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
      occurredAt: new Date(
        `${overrides.occurredAt ?? '2026-09-14'}T00:00:00.000Z`,
      ),
      sequence: await nextTestSequence(prisma, projectId),
    },
  });

  return prisma.purchase.create({
    data: {
      projectId,
      operationId: operation.id,
      supplierId,
      supplierNameSnapshot: 'Test Supplier',
      warehouseId,
      warehouseNameSnapshot: 'Test Warehouse',
      currency,
      exchangeRate: exchangeRate ?? '1',
      ...(currency !== Currency.UZS
        ? { rateOverrideReason: 'test fixture rate' }
        : {}),
      totalAmount,
      totalAmountUzs,
      occurredAt: new Date(
        `${overrides.occurredAt ?? '2026-09-14'}T00:00:00.000Z`,
      ),
      createdById,
    },
  });
}

/** Test fixtures create their own PostedOperation rows directly (bypassing
 * ProjectLockService, since fixtures aren't exercising the lock protocol
 * itself) — this keeps `Project.postingSequence` and `PostedOperation.
 * sequence` consistent with each other so a later real request through the
 * lock doesn't collide with a fixture-created sequence value. */
export async function nextTestSequence(
  prisma: PrismaClient,
  projectId: string,
): Promise<bigint> {
  const updated = await prisma.project.update({
    where: { id: projectId },
    data: { postingSequence: { increment: 1 } },
    select: { postingSequence: true },
  });
  return updated.postingSequence;
}

/**
 * Deletes a project and everything referencing it (finance ledger rows,
 * floors, blocks, and any users still assigned as manager), in FK-safe
 * order — every FK in this schema is RESTRICT (ADR 0001), so a project with
 * children cannot simply be deleted directly.
 *
 * Unlike `RefreshToken.replacedById`, `FinancialTransaction.reversalOfId`
 * and `PostedOperation.reversalOfId` cannot be nulled out before deleting:
 * Phase 4's immutability triggers correctly reject any update to an
 * already-cancelled row's fields, `reversalOfId` included (this is the
 * point of those triggers, not a gap in them) — so instead, reversal rows
 * (the referencing side) are deleted before the original rows they point
 * back at (the referenced side), needing no update at all.
 */
export async function deleteTestProject(
  prisma: PrismaClient,
  projectId: string,
): Promise<void> {
  await prisma.auditLog.deleteMany({ where: { projectId } });
  // Attachment (Phase 9) references Project/User/Purchase/
  // FinancialTransaction/SupplierPayment, so it must be cleared before any
  // of those — nothing else references an Attachment back.
  await prisma.attachment.deleteMany({ where: { projectId } });
  await prisma.financialTransaction.deleteMany({
    where: { projectId, reversalOfId: { not: null } },
  });
  await prisma.financialTransaction.deleteMany({ where: { projectId } });
  // Phase 7/8: StockMovement references PostedOperation, PurchaseItem,
  // StockWriteOff, and WarehouseTransfer, so it must be cleared before any
  // of those — hence before the SettlementAllocation/Purchase/
  // PostedOperation cleanup below too (PurchaseItem cascades from
  // Purchase), and before StockWriteOff/WarehouseTransfer themselves, which
  // in turn must go before the Floor/BuildingBlock/Warehouse/Material
  // cleanup further down (StockWriteOff references Floor+Warehouse+
  // Material; WarehouseTransfer references Warehouse+Material).
  await prisma.stockMovement.deleteMany({ where: { projectId } });
  await prisma.stockWriteOff.deleteMany({ where: { projectId } });
  await prisma.warehouseTransfer.deleteMany({ where: { projectId } });
  // Phase 6: SettlementAllocation/SupplierAdvance/Purchase/SupplierPayment
  // all reference PostedOperation, so they must go before the
  // PostedOperation cleanup below. SettlementAllocation's own reversalOfId
  // self-reference follows the same delete-children-before-parents pattern
  // as every other reversal chain in this file.
  await prisma.settlementAllocation.deleteMany({
    where: { projectId, reversalOfId: { not: null } },
  });
  await prisma.settlementAllocation.deleteMany({ where: { projectId } });
  await prisma.supplierAdvance.deleteMany({ where: { projectId } });
  await prisma.purchaseItem.deleteMany({
    where: { purchase: { projectId } },
  });
  await prisma.purchase.deleteMany({ where: { projectId } });
  await prisma.supplierPayment.deleteMany({ where: { projectId } });
  await prisma.supplier.deleteMany({ where: { projectId } });
  await prisma.postedOperation.deleteMany({
    where: { projectId, reversalOfId: { not: null } },
  });
  await prisma.postedOperation.deleteMany({ where: { projectId } });
  await prisma.currencyRate.deleteMany({ where: { projectId } });
  await prisma.transactionCategory.deleteMany({ where: { projectId } });
  await prisma.floor.deleteMany({ where: { projectId } });
  await prisma.buildingBlock.deleteMany({ where: { projectId } });
  await prisma.inventoryBalance.deleteMany({ where: { projectId } });
  await prisma.material.deleteMany({ where: { projectId } });
  await prisma.materialCategory.deleteMany({ where: { projectId } });
  await prisma.unit.deleteMany({ where: { projectId } });
  await prisma.warehouse.deleteMany({ where: { projectId } });
  const managers = await prisma.user.findMany({
    where: { projectId },
    select: { id: true },
  });
  for (const manager of managers) {
    await deleteTestUser(prisma, manager.id);
  }
  await prisma.project.delete({ where: { id: projectId } });
}

/**
 * Logs in through the real HTTP endpoint (never a hand-constructed JWT) so
 * every e2e test exercises the exact same code path a real client does — see
 * docs/backend-architecture.md §12.
 */
export async function loginTestUser(
  httpServer: Parameters<typeof request>[0],
  email: string,
  password: string = TEST_PASSWORD,
): Promise<string> {
  const response = await request(httpServer)
    .post('/auth/login')
    .send({ email, password })
    .expect(200);
  return response.body.accessToken as string;
}
