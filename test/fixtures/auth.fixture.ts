import { randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import request from 'supertest';
import {
  Currency,
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
  await prisma.financialTransaction.deleteMany({
    where: { ...userFilter, reversalOfId: { not: null } },
  });
  await prisma.financialTransaction.deleteMany({ where: userFilter });
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
  await prisma.financialTransaction.deleteMany({
    where: { projectId, reversalOfId: { not: null } },
  });
  await prisma.financialTransaction.deleteMany({ where: { projectId } });
  await prisma.postedOperation.deleteMany({
    where: { projectId, reversalOfId: { not: null } },
  });
  await prisma.postedOperation.deleteMany({ where: { projectId } });
  await prisma.currencyRate.deleteMany({ where: { projectId } });
  await prisma.transactionCategory.deleteMany({ where: { projectId } });
  await prisma.floor.deleteMany({ where: { projectId } });
  await prisma.buildingBlock.deleteMany({ where: { projectId } });
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
