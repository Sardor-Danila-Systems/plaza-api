import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { TransactionDirection } from '../src/generated/prisma/client.js';
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

describe('Phase 8 inventory operation database constraints (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let projectId: string;
  let userId: string;
  let sourceWarehouseId: string;
  let destinationWarehouseId: string;
  let materialId: string;
  let blockId: string;
  let floorId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => app.close());

  beforeEach(async () => {
    const project = await createTestProject(
      prisma.client,
      `Phase 8 constraints ${randomUUID()}`,
    );
    const user = await createTestUser(prisma.client);
    const category = await createTestMaterialCategory(
      prisma.client,
      project.id,
    );
    const unit = await createTestUnit(prisma.client, project.id);
    const source = await createTestWarehouse(prisma.client, project.id);
    const destination = await createTestWarehouse(prisma.client, project.id);
    const material = await createTestMaterial(
      prisma.client,
      project.id,
      category.id,
      unit.id,
    );
    const block = await prisma.client.buildingBlock.create({
      data: {
        projectId: project.id,
        name: 'Block',
        code: `block-${randomUUID()}`,
      },
    });
    const floor = await prisma.client.floor.create({
      data: {
        projectId: project.id,
        blockId: block.id,
        label: '1',
        sortOrder: 1,
      },
    });
    projectId = project.id;
    userId = user.id;
    sourceWarehouseId = source.id;
    destinationWarehouseId = destination.id;
    materialId = material.id;
    blockId = block.id;
    floorId = floor.id;
  });

  afterEach(async () => deleteTestProject(prisma.client, projectId));

  async function operation(kind: string) {
    return prisma.client.postedOperation.create({
      data: {
        projectId,
        actorId: userId,
        kind,
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
        occurredAt: new Date('2026-09-14T00:00:00.000Z'),
        sequence: await nextTestSequence(prisma.client, projectId),
      },
    });
  }

  function writeOffData(operationId: string, overrides = {}) {
    return {
      projectId,
      operationId,
      warehouseId: sourceWarehouseId,
      warehouseNameSnapshot: 'Source',
      materialId,
      materialNameSnapshot: 'Material',
      blockId,
      floorId,
      blockNameSnapshot: 'Block',
      floorLabelSnapshot: '1',
      quantity: '2',
      unitCostUzs: '100',
      totalCostUzs: '200',
      occurredAt: new Date('2026-09-14T00:00:00.000Z'),
      createdById: userId,
      ...overrides,
    };
  }

  function transferData(operationId: string, overrides = {}) {
    return {
      projectId,
      operationId,
      sourceWarehouseId,
      sourceWarehouseNameSnapshot: 'Source',
      destinationWarehouseId,
      destinationWarehouseNameSnapshot: 'Destination',
      materialId,
      materialNameSnapshot: 'Material',
      quantity: '2',
      unitCostUzs: '100',
      totalCostUzs: '200',
      occurredAt: new Date('2026-09-14T00:00:00.000Z'),
      createdById: userId,
      ...overrides,
    };
  }

  async function createValidWriteOff() {
    const op = await operation('stock_write_off.create');
    return prisma.client.$transaction(async (tx) => {
      const header = await tx.stockWriteOff.create({
        data: writeOffData(op.id),
      });
      await tx.stockMovement.create({
        data: {
          projectId,
          operationId: op.id,
          writeOffId: header.id,
          warehouseId: sourceWarehouseId,
          materialId,
          type: 'WRITE_OFF',
          direction: TransactionDirection.OUT,
          quantity: '2',
          unitCostUzs: '100',
          totalCostUzs: '200',
          occurredAt: new Date('2026-09-14T00:00:00.000Z'),
          createdById: userId,
        },
      });
      return header;
    });
  }

  async function createValidTransfer() {
    const op = await operation('warehouse_transfer.create');
    return prisma.client.$transaction(async (tx) => {
      const header = await tx.warehouseTransfer.create({
        data: transferData(op.id),
      });
      await tx.stockMovement.createMany({
        data: [
          {
            projectId,
            operationId: op.id,
            transferId: header.id,
            warehouseId: sourceWarehouseId,
            materialId,
            type: 'TRANSFER_OUT',
            direction: TransactionDirection.OUT,
            quantity: '2',
            unitCostUzs: '100',
            totalCostUzs: '200',
            occurredAt: new Date('2026-09-14T00:00:00.000Z'),
            createdById: userId,
          },
          {
            projectId,
            operationId: op.id,
            transferId: header.id,
            warehouseId: destinationWarehouseId,
            materialId,
            type: 'TRANSFER_IN',
            direction: TransactionDirection.IN,
            quantity: '2',
            unitCostUzs: '100',
            totalCostUzs: '200',
            occurredAt: new Date('2026-09-14T00:00:00.000Z'),
            createdById: userId,
          },
        ],
      });
      return header;
    });
  }

  it('rejects non-positive write-off quantity', async () => {
    const op = await operation('stock_write_off.create');
    await expect(
      prisma.client.stockWriteOff.create({
        data: writeOffData(op.id, { quantity: '0' }),
      }),
    ).rejects.toThrow(/StockWriteOff_quantity_positive_check/);
  });

  it('rejects a write-off whose floor belongs to another block', async () => {
    const op = await operation('stock_write_off.create');
    const otherBlock = await prisma.client.buildingBlock.create({
      data: {
        projectId,
        name: 'Other',
        code: `block-${randomUUID()}`,
      },
    });
    await expect(
      prisma.client.stockWriteOff.create({
        data: writeOffData(op.id, { blockId: otherBlock.id }),
      }),
    ).rejects.toThrow(/Foreign key constraint/);
  });

  it('rejects a write-off header without its exact movement at commit', async () => {
    const op = await operation('stock_write_off.create');
    await expect(
      prisma.client.$transaction((tx) =>
        tx.stockWriteOff.create({ data: writeOffData(op.id) }),
      ),
    ).rejects.toThrow(/exactly one matching WRITE_OFF movement/);
  });

  it('rejects a write-off movement whose stored cost differs from its header', async () => {
    const op = await operation('stock_write_off.create');
    await expect(
      prisma.client.$transaction(async (tx) => {
        const header = await tx.stockWriteOff.create({
          data: writeOffData(op.id),
        });
        await tx.stockMovement.create({
          data: {
            projectId,
            operationId: op.id,
            writeOffId: header.id,
            warehouseId: sourceWarehouseId,
            materialId,
            type: 'WRITE_OFF',
            direction: 'OUT',
            quantity: '2',
            unitCostUzs: '100',
            totalCostUzs: '199',
            occurredAt: new Date('2026-09-14T00:00:00.000Z'),
            createdById: userId,
          },
        });
      }),
    ).rejects.toThrow(/exactly one matching WRITE_OFF movement/);
  });

  it('write-off immutability rejects posted quantity/cost changes', async () => {
    const header = await createValidWriteOff();
    await expect(
      prisma.client.stockWriteOff.update({
        where: { id: header.id },
        data: { totalCostUzs: '999' },
      }),
    ).rejects.toThrow(/posted fields are immutable/);
  });

  it('rejects a transfer with identical source and destination', async () => {
    const op = await operation('warehouse_transfer.create');
    await expect(
      prisma.client.warehouseTransfer.create({
        data: transferData(op.id, {
          destinationWarehouseId: sourceWarehouseId,
        }),
      }),
    ).rejects.toThrow(/WarehouseTransfer_source_ne_destination_check/);
  });

  it('rejects cross-project warehouse injection through a transfer FK', async () => {
    const other = await createTestProject(
      prisma.client,
      `Foreign constraint ${randomUUID()}`,
    );
    try {
      const foreignWarehouse = await createTestWarehouse(
        prisma.client,
        other.id,
      );
      const op = await operation('warehouse_transfer.create');
      await expect(
        prisma.client.warehouseTransfer.create({
          data: transferData(op.id, {
            destinationWarehouseId: foreignWarehouse.id,
          }),
        }),
      ).rejects.toThrow(/Foreign key constraint/);
    } finally {
      await deleteTestProject(prisma.client, other.id);
    }
  });

  it('rejects a one-sided transfer at commit', async () => {
    const op = await operation('warehouse_transfer.create');
    await expect(
      prisma.client.$transaction(async (tx) => {
        const header = await tx.warehouseTransfer.create({
          data: transferData(op.id),
        });
        await tx.stockMovement.create({
          data: {
            projectId,
            operationId: op.id,
            transferId: header.id,
            warehouseId: sourceWarehouseId,
            materialId,
            type: 'TRANSFER_OUT',
            direction: 'OUT',
            quantity: '2',
            unitCostUzs: '100',
            totalCostUzs: '200',
            occurredAt: new Date('2026-09-14T00:00:00.000Z'),
            createdById: userId,
          },
        });
      }),
    ).rejects.toThrow(/exactly two matching opposite movements/);
  });

  it('rejects transfer legs with unequal carrying values', async () => {
    const op = await operation('warehouse_transfer.create');
    await expect(
      prisma.client.$transaction(async (tx) => {
        const header = await tx.warehouseTransfer.create({
          data: transferData(op.id),
        });
        await tx.stockMovement.createMany({
          data: [
            {
              projectId,
              operationId: op.id,
              transferId: header.id,
              warehouseId: sourceWarehouseId,
              materialId,
              type: 'TRANSFER_OUT',
              direction: 'OUT',
              quantity: '2',
              unitCostUzs: '100',
              totalCostUzs: '200',
              occurredAt: new Date('2026-09-14T00:00:00.000Z'),
              createdById: userId,
            },
            {
              projectId,
              operationId: op.id,
              transferId: header.id,
              warehouseId: destinationWarehouseId,
              materialId,
              type: 'TRANSFER_IN',
              direction: 'IN',
              quantity: '2',
              unitCostUzs: '100',
              totalCostUzs: '199',
              occurredAt: new Date('2026-09-14T00:00:00.000Z'),
              createdById: userId,
            },
          ],
        });
      }),
    ).rejects.toThrow(/exactly two matching opposite movements/);
  });

  it('accepts an exact paired transfer and keeps the header immutable', async () => {
    const header = await createValidTransfer();
    expect(
      await prisma.client.stockMovement.count({
        where: { transferId: header.id },
      }),
    ).toBe(2);
    await expect(
      prisma.client.warehouseTransfer.update({
        where: { id: header.id },
        data: { quantity: '3' },
      }),
    ).rejects.toThrow(/posted fields are immutable/);
  });
});
