import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { setupApp } from '../src/setup-app.js';
import {
  createTestMaterial,
  createTestMaterialCategory,
  createTestProject,
  createTestUnit,
  createTestUser,
  createTestWarehouse,
  deleteTestProject,
  nextTestSequence,
} from './fixtures/auth.fixture.js';

/**
 * Direct-database verification of every hand-written CHECK constraint,
 * composite FK, and immutability trigger Phase 5's migration adds —
 * bypassing the service layer entirely, the same discipline as
 * test/finances-db-constraints.e2e-spec.ts.
 */
describe('Inventory database constraints (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let projectId: string;
  let userId: string;
  let warehouseId: string;
  let materialId: string;
  let operationId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const project = await createTestProject(
      prisma.client,
      `Inventory Constraint Test ${randomUUID()}`,
    );
    const user = await createTestUser(prisma.client);
    const category = await createTestMaterialCategory(
      prisma.client,
      project.id,
    );
    const unit = await createTestUnit(prisma.client, project.id);
    const warehouse = await createTestWarehouse(prisma.client, project.id);
    const material = await createTestMaterial(
      prisma.client,
      project.id,
      category.id,
      unit.id,
    );
    projectId = project.id;
    userId = user.id;
    warehouseId = warehouse.id;
    materialId = material.id;

    const operation = await prisma.client.postedOperation.create({
      data: {
        projectId,
        actorId: userId,
        kind: 'test',
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
        occurredAt: new Date('2026-09-14T00:00:00.000Z'),
        sequence: await nextTestSequence(prisma.client, projectId),
      },
    });
    operationId = operation.id;
  });

  afterEach(async () => {
    await deleteTestProject(prisma.client, projectId);
  });

  describe('Material constraints', () => {
    it('rejects a negative minimumStock', async () => {
      await expect(
        prisma.client.material.create({
          data: {
            projectId,
            categoryId: (
              await prisma.client.material.findFirstOrThrow({
                where: { id: materialId },
              })
            ).categoryId,
            unitId: (
              await prisma.client.material.findFirstOrThrow({
                where: { id: materialId },
              })
            ).unitId,
            name: 'Bad',
            code: 'bad-min',
            minimumStock: '-1',
          },
        }),
      ).rejects.toThrow(/Material_minimumStock_nonnegative_check/);
    });
  });

  describe('InventoryBalance constraints', () => {
    it('rejects a negative quantity', async () => {
      await expect(
        prisma.client.inventoryBalance.create({
          data: {
            projectId,
            warehouseId,
            materialId,
            quantity: '-1',
            valueUzs: '0',
          },
        }),
      ).rejects.toThrow(/InventoryBalance_quantity_nonnegative_check/);
    });

    it('rejects a negative valueUzs', async () => {
      await expect(
        prisma.client.inventoryBalance.create({
          data: {
            projectId,
            warehouseId,
            materialId,
            quantity: '5',
            valueUzs: '-1',
          },
        }),
      ).rejects.toThrow(/InventoryBalance_valueUzs_nonnegative_check/);
    });

    it('rejects zero quantity with a nonzero value', async () => {
      await expect(
        prisma.client.inventoryBalance.create({
          data: {
            projectId,
            warehouseId,
            materialId,
            quantity: '0',
            valueUzs: '100',
          },
        }),
      ).rejects.toThrow(/InventoryBalance_zero_quantity_zero_value_check/);
    });

    it('allows zero quantity with zero value', async () => {
      await expect(
        prisma.client.inventoryBalance.create({
          data: {
            projectId,
            warehouseId,
            materialId,
            quantity: '0',
            valueUzs: '0',
          },
        }),
      ).resolves.toBeDefined();
    });

    it('allows a positive quantity with zero value (not itself forbidden)', async () => {
      await expect(
        prisma.client.inventoryBalance.create({
          data: {
            projectId,
            warehouseId,
            materialId,
            quantity: '5',
            valueUzs: '0',
          },
        }),
      ).resolves.toBeDefined();
    });

    it('rejects a duplicate (warehouseId, materialId) pair', async () => {
      await prisma.client.inventoryBalance.create({
        data: {
          projectId,
          warehouseId,
          materialId,
          quantity: '5',
          valueUzs: '500',
        },
      });
      await expect(
        prisma.client.inventoryBalance.create({
          data: {
            projectId,
            warehouseId,
            materialId,
            quantity: '10',
            valueUzs: '1000',
          },
        }),
      ).rejects.toThrow(/Unique constraint/);
    });

    it('rejects a cross-project warehouse/material combination via composite FK', async () => {
      const other = await createTestProject(
        prisma.client,
        `Other ${randomUUID()}`,
      );
      try {
        const foreignWarehouse = await createTestWarehouse(
          prisma.client,
          other.id,
        );
        await expect(
          prisma.client.inventoryBalance.create({
            data: {
              projectId,
              warehouseId: foreignWarehouse.id,
              materialId,
              quantity: '5',
              valueUzs: '500',
            },
          }),
        ).rejects.toThrow(/Foreign key constraint/);
      } finally {
        await deleteTestProject(prisma.client, other.id);
      }
    });
  });

  describe('StockMovement constraints', () => {
    function baseMovement(overrides: Record<string, unknown> = {}) {
      return {
        projectId,
        operationId,
        warehouseId,
        materialId,
        type: 'OPENING_RECEIPT' as const,
        direction: 'IN' as const,
        quantity: '10',
        unitCostUzs: '100',
        totalCostUzs: '1000',
        occurredAt: new Date('2026-09-14T00:00:00.000Z'),
        createdById: userId,
        ...overrides,
      };
    }

    it('rejects quantity <= 0', async () => {
      await expect(
        prisma.client.stockMovement.create({
          data: baseMovement({ quantity: '0' }),
        }),
      ).rejects.toThrow(/StockMovement_quantity_positive_check/);
    });

    it('rejects a negative unitCostUzs', async () => {
      await expect(
        prisma.client.stockMovement.create({
          data: baseMovement({ unitCostUzs: '-1' }),
        }),
      ).rejects.toThrow(/StockMovement_unitCostUzs_nonnegative_check/);
    });

    it('rejects a negative totalCostUzs', async () => {
      await expect(
        prisma.client.stockMovement.create({
          data: baseMovement({ totalCostUzs: '-1' }),
        }),
      ).rejects.toThrow(/StockMovement_totalCostUzs_nonnegative_check/);
    });

    it('rejects a cross-project warehouse relation via composite FK', async () => {
      const other = await createTestProject(
        prisma.client,
        `Other ${randomUUID()}`,
      );
      try {
        const foreignWarehouse = await createTestWarehouse(
          prisma.client,
          other.id,
        );
        await expect(
          prisma.client.stockMovement.create({
            data: baseMovement({ warehouseId: foreignWarehouse.id }),
          }),
        ).rejects.toThrow(/Foreign key constraint/);
      } finally {
        await deleteTestProject(prisma.client, other.id);
      }
    });

    it('rejects a cross-project material relation via composite FK', async () => {
      const other = await createTestProject(
        prisma.client,
        `Other ${randomUUID()}`,
      );
      try {
        const category = await createTestMaterialCategory(
          prisma.client,
          other.id,
        );
        const unit = await createTestUnit(prisma.client, other.id);
        const foreignMaterial = await createTestMaterial(
          prisma.client,
          other.id,
          category.id,
          unit.id,
        );
        await expect(
          prisma.client.stockMovement.create({
            data: baseMovement({ materialId: foreignMaterial.id }),
          }),
        ).rejects.toThrow(/Foreign key constraint/);
      } finally {
        await deleteTestProject(prisma.client, other.id);
      }
    });

    it('accepts a valid movement', async () => {
      await expect(
        prisma.client.stockMovement.create({ data: baseMovement() }),
      ).resolves.toBeDefined();
    });

    it('the immutability trigger rejects any UPDATE at all', async () => {
      const movement = await prisma.client.stockMovement.create({
        data: baseMovement(),
      });
      await expect(
        prisma.client.stockMovement.update({
          where: { id: movement.id },
          data: { quantity: '999' },
        }),
      ).rejects.toThrow(/append-only/);
    });

    it('the immutability trigger rejects even a no-op UPDATE', async () => {
      const movement = await prisma.client.stockMovement.create({
        data: baseMovement(),
      });
      await expect(
        prisma.client.stockMovement.update({
          where: { id: movement.id },
          data: { quantity: movement.quantity },
        }),
      ).rejects.toThrow(/append-only/);
    });
  });
});
