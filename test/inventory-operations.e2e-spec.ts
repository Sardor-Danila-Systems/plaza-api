import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Role } from '../src/generated/prisma/client.js';
import { setupApp } from '../src/setup-app.js';
import {
  createTestMaterial,
  createTestMaterialCategory,
  createTestProject,
  createTestSupplier,
  createTestUnit,
  createTestUser,
  createTestWarehouse,
  deleteTestProject,
  deleteTestUser,
  loginTestUser,
} from './fixtures/auth.fixture.js';

describe('Phase 8 inventory operations (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

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

  function idem(): string {
    return randomUUID();
  }

  async function setupDomain() {
    const project = await createTestProject(
      prisma.client,
      `Phase 8 ${randomUUID()}`,
    );
    const manager = await createTestUser(prisma.client, {
      role: Role.PROJECT_MANAGER,
      projectId: project.id,
    });
    const token = await loginTestUser(app.getHttpServer(), manager.email);
    const category = await createTestMaterialCategory(
      prisma.client,
      project.id,
    );
    const unit = await createTestUnit(prisma.client, project.id);
    const source = await createTestWarehouse(prisma.client, project.id, {
      name: 'Source',
    });
    const destination = await createTestWarehouse(prisma.client, project.id, {
      name: 'Destination',
    });
    const material = await createTestMaterial(
      prisma.client,
      project.id,
      category.id,
      unit.id,
      { name: 'Cement' },
    );
    const supplier = await createTestSupplier(prisma.client, project.id);
    const block = await prisma.client.buildingBlock.create({
      data: {
        projectId: project.id,
        name: 'Block A',
        code: `block-${randomUUID()}`,
      },
    });
    const floor = await prisma.client.floor.create({
      data: {
        projectId: project.id,
        blockId: block.id,
        label: 'Floor 1',
        sortOrder: 1,
      },
    });
    return {
      project,
      manager,
      token,
      category,
      unit,
      source,
      destination,
      material,
      supplier,
      block,
      floor,
    };
  }

  async function receive(
    domain: Awaited<ReturnType<typeof setupDomain>>,
    warehouseId: string,
    quantity: string,
    unitPrice: string,
  ) {
    return request(app.getHttpServer())
      .post(`/projects/${domain.project.id}/purchases`)
      .set('Authorization', `Bearer ${domain.token}`)
      .set('Idempotency-Key', idem())
      .send({
        supplierId: domain.supplier.id,
        warehouseId,
        currency: 'UZS',
        items: [{ materialId: domain.material.id, quantity, unitPrice }],
        occurredAt: '2026-09-14',
      })
      .expect(201);
  }

  function writeOffBody(domain: Awaited<ReturnType<typeof setupDomain>>) {
    return {
      warehouseId: domain.source.id,
      materialId: domain.material.id,
      quantity: '2.000000',
      blockId: domain.block.id,
      floorId: domain.floor.id,
      occurredAt: '2026-09-14',
      comment: 'Used on slab',
    };
  }

  it('creates, lists, and gets a partial write-off at the current average cost without cash', async () => {
    const domain = await setupDomain();
    try {
      await receive(domain, domain.source.id, '10.000000', '100.00000000');
      const financialCountBefore =
        await prisma.client.financialTransaction.count({
          where: { projectId: domain.project.id },
        });
      const created = await request(app.getHttpServer())
        .post(`/projects/${domain.project.id}/inventory/write-offs`)
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', idem())
        .send(writeOffBody(domain))
        .expect(201);
      expect(created.body.unitCostUzs).toBe('100.00000000');
      expect(created.body.totalCostUzs).toBe('200.00000000');
      expect(created.body.blockNameSnapshot).toBe('Block A');

      const list = await request(app.getHttpServer())
        .get(`/projects/${domain.project.id}/inventory/write-offs`)
        .set('Authorization', `Bearer ${domain.token}`)
        .expect(200);
      expect(list.body.total).toBe(1);
      const get = await request(app.getHttpServer())
        .get(
          `/projects/${domain.project.id}/inventory/write-offs/${created.body.id}`,
        )
        .set('Authorization', `Bearer ${domain.token}`)
        .expect(200);
      expect(get.body.id).toBe(created.body.id);

      const balance = await prisma.client.inventoryBalance.findUniqueOrThrow({
        where: {
          warehouseId_materialId: {
            warehouseId: domain.source.id,
            materialId: domain.material.id,
          },
        },
      });
      expect(balance.quantity.toFixed(6)).toBe('8.000000');
      expect(balance.valueUzs.toFixed(8)).toBe('800.00000000');
      expect(
        await prisma.client.financialTransaction.count({
          where: { projectId: domain.project.id },
        }),
      ).toBe(financialCountBefore);
    } finally {
      await deleteTestProject(prisma.client, domain.project.id);
    }
  });

  it('full write-off explicitly depletes quantity and value to zero', async () => {
    const domain = await setupDomain();
    try {
      await receive(domain, domain.source.id, '3.000000', '3.33333333');
      await request(app.getHttpServer())
        .post(`/projects/${domain.project.id}/inventory/write-offs`)
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', idem())
        .send({ ...writeOffBody(domain), quantity: '3.000000' })
        .expect(201);
      const balance = await prisma.client.inventoryBalance.findUniqueOrThrow({
        where: {
          warehouseId_materialId: {
            warehouseId: domain.source.id,
            materialId: domain.material.id,
          },
        },
      });
      expect(balance.quantity.toFixed(6)).toBe('0.000000');
      expect(balance.valueUzs.toFixed(8)).toBe('0.00000000');
    } finally {
      await deleteTestProject(prisma.client, domain.project.id);
    }
  });

  it('rejects insufficient stock and invalid warehouse/material/block/floor relationships', async () => {
    const domain = await setupDomain();
    try {
      const insufficient = await request(app.getHttpServer())
        .post(`/projects/${domain.project.id}/inventory/write-offs`)
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', idem())
        .send(writeOffBody(domain))
        .expect(409);
      expect(insufficient.body.code).toBe('INSUFFICIENT_STOCK');

      for (const field of ['warehouseId', 'materialId', 'blockId'] as const) {
        await request(app.getHttpServer())
          .post(`/projects/${domain.project.id}/inventory/write-offs`)
          .set('Authorization', `Bearer ${domain.token}`)
          .set('Idempotency-Key', idem())
          .send({ ...writeOffBody(domain), [field]: randomUUID() })
          .expect(404);
      }

      const otherBlock = await prisma.client.buildingBlock.create({
        data: {
          projectId: domain.project.id,
          name: 'Block B',
          code: `block-${randomUUID()}`,
        },
      });
      await request(app.getHttpServer())
        .post(`/projects/${domain.project.id}/inventory/write-offs`)
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', idem())
        .send({ ...writeOffBody(domain), blockId: otherBlock.id })
        .expect(404);
    } finally {
      await deleteTestProject(prisma.client, domain.project.id);
    }
  });

  it('keeps the historical write-off cost after a future purchase changes the average', async () => {
    const domain = await setupDomain();
    try {
      await receive(domain, domain.source.id, '10.000000', '100.00000000');
      const writeOff = await request(app.getHttpServer())
        .post(`/projects/${domain.project.id}/inventory/write-offs`)
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', idem())
        .send(writeOffBody(domain))
        .expect(201);
      await receive(domain, domain.source.id, '2.000000', '500.00000000');
      const stored = await prisma.client.stockWriteOff.findUniqueOrThrow({
        where: { id: writeOff.body.id },
      });
      expect(stored.unitCostUzs.toFixed(8)).toBe('100.00000000');
      expect(stored.totalCostUzs.toFixed(8)).toBe('200.00000000');
    } finally {
      await deleteTestProject(prisma.client, domain.project.id);
    }
  });

  it('write-off create is idempotent and payload drift returns 409', async () => {
    const domain = await setupDomain();
    try {
      await receive(domain, domain.source.id, '10.000000', '100.00000000');
      const key = idem();
      const first = await request(app.getHttpServer())
        .post(`/projects/${domain.project.id}/inventory/write-offs`)
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', key)
        .send(writeOffBody(domain))
        .expect(201);
      const replay = await request(app.getHttpServer())
        .post(`/projects/${domain.project.id}/inventory/write-offs`)
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', key)
        .send(writeOffBody(domain))
        .expect(200);
      expect(replay.body.id).toBe(first.body.id);
      const drift = await request(app.getHttpServer())
        .post(`/projects/${domain.project.id}/inventory/write-offs`)
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', key)
        .send({ ...writeOffBody(domain), quantity: '3.000000' })
        .expect(409);
      expect(drift.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(
        await prisma.client.stockWriteOff.count({
          where: { projectId: domain.project.id },
        }),
      ).toBe(1);

      await request(app.getHttpServer())
        .post(`/projects/${domain.project.id}/inventory/write-offs`)
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', idem())
        .send({
          ...writeOffBody(domain),
          unitCostUzs: '0.00000000',
          totalCostUzs: '0.00000000',
          projectId: randomUUID(),
          createdById: randomUUID(),
        })
        .expect(400);
    } finally {
      await deleteTestProject(prisma.client, domain.project.id);
    }
  });

  it('cancels a safe write-off and rejects cancellation after a later movement', async () => {
    const domain = await setupDomain();
    try {
      await receive(domain, domain.source.id, '10.000000', '100.00000000');
      const first = await request(app.getHttpServer())
        .post(`/projects/${domain.project.id}/inventory/write-offs`)
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', idem())
        .send(writeOffBody(domain))
        .expect(201);
      await receive(domain, domain.source.id, '1.000000', '200.00000000');
      const blocked = await request(app.getHttpServer())
        .post(
          `/projects/${domain.project.id}/inventory/write-offs/${first.body.id}/cancel`,
        )
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', idem())
        .send({ reason: 'Wrong floor' })
        .expect(409);
      expect(blocked.body.code).toBe('CANCELLATION_HAS_DEPENDENCIES');

      const second = await request(app.getHttpServer())
        .post(`/projects/${domain.project.id}/inventory/write-offs`)
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', idem())
        .send({ ...writeOffBody(domain), quantity: '1.000000' })
        .expect(201);
      const cancelled = await request(app.getHttpServer())
        .post(
          `/projects/${domain.project.id}/inventory/write-offs/${second.body.id}/cancel`,
        )
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', 'write-off-cancel-replay')
        .send({ reason: 'Wrong floor' })
        .expect(200);
      expect(cancelled.body.cancelledAt).not.toBeNull();
      const replay = await request(app.getHttpServer())
        .post(
          `/projects/${domain.project.id}/inventory/write-offs/${second.body.id}/cancel`,
        )
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', 'write-off-cancel-replay')
        .send({ reason: 'Wrong floor' })
        .expect(200);
      expect(replay.body.id).toBe(second.body.id);
      const drift = await request(app.getHttpServer())
        .post(
          `/projects/${domain.project.id}/inventory/write-offs/${second.body.id}/cancel`,
        )
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', 'write-off-cancel-replay')
        .send({ reason: 'Different reason' })
        .expect(409);
      expect(drift.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(
        await prisma.client.stockMovement.count({
          where: { writeOffId: second.body.id },
        }),
      ).toBe(2);
    } finally {
      await deleteTestProject(prisma.client, domain.project.id);
    }
  });

  it('purchase cancellation is blocked after write-off or transfer dependency with no partial reversal', async () => {
    const domain = await setupDomain();
    try {
      const purchase = await receive(
        domain,
        domain.source.id,
        '10.000000',
        '100.00000000',
      );
      await request(app.getHttpServer())
        .post(`/projects/${domain.project.id}/inventory/write-offs`)
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', idem())
        .send(writeOffBody(domain))
        .expect(201);
      const blocked = await request(app.getHttpServer())
        .post(
          `/projects/${domain.project.id}/purchases/${purchase.body.id}/cancel`,
        )
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', idem())
        .send({ reason: 'Try unsafe cancellation' })
        .expect(409);
      expect(blocked.body.code).toBe('PURCHASE_HAS_DEPENDENT_MOVEMENTS');
      expect(
        await prisma.client.stockMovement.count({
          where: { purchaseItemId: purchase.body.items[0].id },
        }),
      ).toBe(1);

      const secondMaterial = await createTestMaterial(
        prisma.client,
        domain.project.id,
        domain.category.id,
        domain.unit.id,
      );
      domain.material = secondMaterial;
      const secondPurchase = await receive(
        domain,
        domain.source.id,
        '10.000000',
        '100.00000000',
      );
      await request(app.getHttpServer())
        .post(`/projects/${domain.project.id}/inventory/transfers`)
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', idem())
        .send({
          sourceWarehouseId: domain.source.id,
          destinationWarehouseId: domain.destination.id,
          materialId: secondMaterial.id,
          quantity: '2.000000',
          occurredAt: '2026-09-14',
        })
        .expect(201);
      const transferBlocked = await request(app.getHttpServer())
        .post(
          `/projects/${domain.project.id}/purchases/${secondPurchase.body.id}/cancel`,
        )
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', idem())
        .send({ reason: 'Try unsafe transfer dependency cancellation' })
        .expect(409);
      expect(transferBlocked.body.code).toBe(
        'PURCHASE_HAS_DEPENDENT_MOVEMENTS',
      );
    } finally {
      await deleteTestProject(prisma.client, domain.project.id);
    }
  });

  it('full transfer preserves source cost and produces the destination weighted average with paired movements and no cash', async () => {
    const domain = await setupDomain();
    try {
      await receive(domain, domain.source.id, '10.000000', '100.00000000');
      await receive(domain, domain.destination.id, '10.000000', '200.00000000');
      const cashBefore = await prisma.client.financialTransaction.count({
        where: { projectId: domain.project.id },
      });
      const transfer = await request(app.getHttpServer())
        .post(`/projects/${domain.project.id}/inventory/transfers`)
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', idem())
        .send({
          sourceWarehouseId: domain.source.id,
          destinationWarehouseId: domain.destination.id,
          materialId: domain.material.id,
          quantity: '10.000000',
          occurredAt: '2026-09-14',
        })
        .expect(201);
      expect(transfer.body.unitCostUzs).toBe('100.00000000');

      const [sourceBalance, destinationBalance, movements] = await Promise.all([
        prisma.client.inventoryBalance.findUniqueOrThrow({
          where: {
            warehouseId_materialId: {
              warehouseId: domain.source.id,
              materialId: domain.material.id,
            },
          },
        }),
        prisma.client.inventoryBalance.findUniqueOrThrow({
          where: {
            warehouseId_materialId: {
              warehouseId: domain.destination.id,
              materialId: domain.material.id,
            },
          },
        }),
        prisma.client.stockMovement.findMany({
          where: { transferId: transfer.body.id },
          orderBy: { type: 'asc' },
        }),
      ]);
      expect(sourceBalance.quantity.toFixed(6)).toBe('0.000000');
      expect(sourceBalance.valueUzs.toFixed(8)).toBe('0.00000000');
      expect(destinationBalance.quantity.toFixed(6)).toBe('20.000000');
      expect(destinationBalance.valueUzs.toFixed(8)).toBe('3000.00000000');
      expect(
        destinationBalance.valueUzs
          .dividedBy(destinationBalance.quantity)
          .toFixed(8),
      ).toBe('150.00000000');
      expect(movements).toHaveLength(2);
      expect(new Set(movements.map((movement) => movement.type))).toEqual(
        new Set(['TRANSFER_OUT', 'TRANSFER_IN']),
      );
      expect(movements[0]?.operationId).toBe(movements[1]?.operationId);
      expect(
        await prisma.client.financialTransaction.count({
          where: { projectId: domain.project.id },
        }),
      ).toBe(cashBefore);
    } finally {
      await deleteTestProject(prisma.client, domain.project.id);
    }
  });

  it('partial transfer preserves source average and initializes an empty destination', async () => {
    const domain = await setupDomain();
    try {
      await receive(domain, domain.source.id, '10.000000', '100.00000000');
      await request(app.getHttpServer())
        .post(`/projects/${domain.project.id}/inventory/transfers`)
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', idem())
        .send({
          sourceWarehouseId: domain.source.id,
          destinationWarehouseId: domain.destination.id,
          materialId: domain.material.id,
          quantity: '4.000000',
          occurredAt: '2026-09-14',
        })
        .expect(201);
      const source = await prisma.client.inventoryBalance.findUniqueOrThrow({
        where: {
          warehouseId_materialId: {
            warehouseId: domain.source.id,
            materialId: domain.material.id,
          },
        },
      });
      const destination =
        await prisma.client.inventoryBalance.findUniqueOrThrow({
          where: {
            warehouseId_materialId: {
              warehouseId: domain.destination.id,
              materialId: domain.material.id,
            },
          },
        });
      expect(source.quantity.toFixed(6)).toBe('6.000000');
      expect(source.valueUzs.dividedBy(source.quantity).toFixed(8)).toBe(
        '100.00000000',
      );
      expect(destination.quantity.toFixed(6)).toBe('4.000000');
      expect(destination.valueUzs.toFixed(8)).toBe('400.00000000');
    } finally {
      await deleteTestProject(prisma.client, domain.project.id);
    }
  });

  it('rejects same-warehouse, insufficient-stock, and cross-project transfers', async () => {
    const domain = await setupDomain();
    const other = await createTestProject(
      prisma.client,
      `Foreign transfer ${randomUUID()}`,
    );
    try {
      const foreignWarehouse = await createTestWarehouse(
        prisma.client,
        other.id,
      );
      const base = {
        sourceWarehouseId: domain.source.id,
        destinationWarehouseId: domain.destination.id,
        materialId: domain.material.id,
        quantity: '1.000000',
        occurredAt: '2026-09-14',
      };
      await request(app.getHttpServer())
        .post(`/projects/${domain.project.id}/inventory/transfers`)
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', idem())
        .send({ ...base, destinationWarehouseId: domain.source.id })
        .expect(400);
      const insufficient = await request(app.getHttpServer())
        .post(`/projects/${domain.project.id}/inventory/transfers`)
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', idem())
        .send(base)
        .expect(409);
      expect(insufficient.body.code).toBe('INSUFFICIENT_STOCK');
      const foreign = await request(app.getHttpServer())
        .post(`/projects/${domain.project.id}/inventory/transfers`)
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', idem())
        .send({ ...base, destinationWarehouseId: foreignWarehouse.id })
        .expect(409);
      expect(foreign.body.code).toBe('CROSS_PROJECT_TRANSFER_FORBIDDEN');
    } finally {
      await deleteTestProject(prisma.client, domain.project.id);
      await deleteTestProject(prisma.client, other.id);
    }
  });

  it('transfer create replays, lists/gets, and safe cancellation restores both balances', async () => {
    const domain = await setupDomain();
    try {
      await receive(domain, domain.source.id, '10.000000', '100.00000000');
      const body = {
        sourceWarehouseId: domain.source.id,
        destinationWarehouseId: domain.destination.id,
        materialId: domain.material.id,
        quantity: '4.000000',
        occurredAt: '2026-09-14',
      };
      const key = idem();
      const first = await request(app.getHttpServer())
        .post(`/projects/${domain.project.id}/inventory/transfers`)
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);
      const replay = await request(app.getHttpServer())
        .post(`/projects/${domain.project.id}/inventory/transfers`)
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', key)
        .send(body)
        .expect(200);
      expect(replay.body.id).toBe(first.body.id);
      const drift = await request(app.getHttpServer())
        .post(`/projects/${domain.project.id}/inventory/transfers`)
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', key)
        .send({ ...body, quantity: '5.000000' })
        .expect(409);
      expect(drift.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      const list = await request(app.getHttpServer())
        .get(`/projects/${domain.project.id}/inventory/transfers`)
        .set('Authorization', `Bearer ${domain.token}`)
        .expect(200);
      expect(list.body.total).toBe(1);
      await request(app.getHttpServer())
        .get(
          `/projects/${domain.project.id}/inventory/transfers/${first.body.id}`,
        )
        .set('Authorization', `Bearer ${domain.token}`)
        .expect(200);

      const cancelled = await request(app.getHttpServer())
        .post(
          `/projects/${domain.project.id}/inventory/transfers/${first.body.id}/cancel`,
        )
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', 'transfer-cancel-replay')
        .send({ reason: 'Wrong destination' })
        .expect(200);
      expect(cancelled.body.cancelledAt).not.toBeNull();
      const cancelReplay = await request(app.getHttpServer())
        .post(
          `/projects/${domain.project.id}/inventory/transfers/${first.body.id}/cancel`,
        )
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', 'transfer-cancel-replay')
        .send({ reason: 'Wrong destination' })
        .expect(200);
      expect(cancelReplay.body.id).toBe(first.body.id);
      const cancelDrift = await request(app.getHttpServer())
        .post(
          `/projects/${domain.project.id}/inventory/transfers/${first.body.id}/cancel`,
        )
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', 'transfer-cancel-replay')
        .send({ reason: 'Different destination' })
        .expect(409);
      expect(cancelDrift.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      const source = await prisma.client.inventoryBalance.findUniqueOrThrow({
        where: {
          warehouseId_materialId: {
            warehouseId: domain.source.id,
            materialId: domain.material.id,
          },
        },
      });
      const destination =
        await prisma.client.inventoryBalance.findUniqueOrThrow({
          where: {
            warehouseId_materialId: {
              warehouseId: domain.destination.id,
              materialId: domain.material.id,
            },
          },
        });
      expect(source.quantity.toFixed(6)).toBe('10.000000');
      expect(source.valueUzs.toFixed(8)).toBe('1000.00000000');
      expect(destination.quantity.toFixed(6)).toBe('0.000000');
      expect(destination.valueUzs.toFixed(8)).toBe('0.00000000');
      expect(
        await prisma.client.stockMovement.count({
          where: { transferId: first.body.id },
        }),
      ).toBe(4);
    } finally {
      await deleteTestProject(prisma.client, domain.project.id);
    }
  });

  it('rejects transfer cancellation after a later dependent destination movement', async () => {
    const domain = await setupDomain();
    try {
      await receive(domain, domain.source.id, '10.000000', '100.00000000');
      const transfer = await request(app.getHttpServer())
        .post(`/projects/${domain.project.id}/inventory/transfers`)
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', idem())
        .send({
          sourceWarehouseId: domain.source.id,
          destinationWarehouseId: domain.destination.id,
          materialId: domain.material.id,
          quantity: '4.000000',
          occurredAt: '2026-09-14',
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/projects/${domain.project.id}/inventory/write-offs`)
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', idem())
        .send({
          ...writeOffBody(domain),
          warehouseId: domain.destination.id,
          quantity: '1.000000',
        })
        .expect(201);
      const blocked = await request(app.getHttpServer())
        .post(
          `/projects/${domain.project.id}/inventory/transfers/${transfer.body.id}/cancel`,
        )
        .set('Authorization', `Bearer ${domain.token}`)
        .set('Idempotency-Key', idem())
        .send({ reason: 'Too late' })
        .expect(409);
      expect(blocked.body.code).toBe('CANCELLATION_HAS_DEPENDENCIES');
    } finally {
      await deleteTestProject(prisma.client, domain.project.id);
    }
  });

  it('OWNER and ACCOUNTANT can read but cannot mutate, and foreign managers cannot access', async () => {
    const domain = await setupDomain();
    const owner = await createTestUser(prisma.client, { role: Role.OWNER });
    const accountant = await createTestUser(prisma.client, {
      role: Role.ACCOUNTANT,
    });
    const foreignDomain = await setupDomain();
    try {
      for (const reader of [owner, accountant]) {
        const token = await loginTestUser(app.getHttpServer(), reader.email);
        await request(app.getHttpServer())
          .get(`/projects/${domain.project.id}/inventory/write-offs`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        await request(app.getHttpServer())
          .get(`/projects/${domain.project.id}/inventory/transfers`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        await request(app.getHttpServer())
          .post(`/projects/${domain.project.id}/inventory/write-offs`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send(writeOffBody(domain))
          .expect(403);
        await request(app.getHttpServer())
          .post(`/projects/${domain.project.id}/inventory/transfers`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            sourceWarehouseId: domain.source.id,
            destinationWarehouseId: domain.destination.id,
            materialId: domain.material.id,
            quantity: '1.000000',
            occurredAt: '2026-09-14',
          })
          .expect(403);
      }
      await request(app.getHttpServer())
        .get(`/projects/${domain.project.id}/inventory/transfers`)
        .set('Authorization', `Bearer ${foreignDomain.token}`)
        .expect(403);
    } finally {
      await deleteTestUser(prisma.client, owner.id);
      await deleteTestUser(prisma.client, accountant.id);
      await deleteTestProject(prisma.client, domain.project.id);
      await deleteTestProject(prisma.client, foreignDomain.project.id);
    }
  });
});
