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
  loginTestUser,
} from './fixtures/auth.fixture.js';

describe('Phase 8 inventory concurrency (e2e)', () => {
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

  async function setupStock() {
    const project = await createTestProject(
      prisma.client,
      `Phase 8 race ${randomUUID()}`,
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
    const source = await createTestWarehouse(prisma.client, project.id);
    const destination = await createTestWarehouse(prisma.client, project.id);
    const material = await createTestMaterial(
      prisma.client,
      project.id,
      category.id,
      unit.id,
    );
    const supplier = await createTestSupplier(prisma.client, project.id);
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
    const purchase = await request(app.getHttpServer())
      .post(`/projects/${project.id}/purchases`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idem())
      .send({
        supplierId: supplier.id,
        warehouseId: source.id,
        currency: 'UZS',
        items: [
          {
            materialId: material.id,
            quantity: '10.000000',
            unitPrice: '100.00000000',
          },
        ],
        occurredAt: '2026-09-14',
      })
      .expect(201);
    const writeOffBody = {
      warehouseId: source.id,
      materialId: material.id,
      quantity: '6.000000',
      blockId: block.id,
      floorId: floor.id,
      occurredAt: '2026-09-14',
    };
    const transferBody = {
      sourceWarehouseId: source.id,
      destinationWarehouseId: destination.id,
      materialId: material.id,
      quantity: '6.000000',
      occurredAt: '2026-09-14',
    };
    return {
      project,
      token,
      source,
      destination,
      material,
      purchase,
      writeOffBody,
      transferBody,
    };
  }

  async function assertProjectCounts(
    projectId: string,
    expected: { movements: number; operations: number },
  ) {
    expect(
      await prisma.client.stockMovement.count({ where: { projectId } }),
    ).toBe(expected.movements);
    expect(
      await prisma.client.postedOperation.count({ where: { projectId } }),
    ).toBe(expected.operations);
  }

  it('concurrent duplicate write-offs have one business effect', async () => {
    const domain = await setupStock();
    try {
      const key = idem();
      const [a, b] = await Promise.all([
        request(app.getHttpServer())
          .post(`/projects/${domain.project.id}/inventory/write-offs`)
          .set('Authorization', `Bearer ${domain.token}`)
          .set('Idempotency-Key', key)
          .send({ ...domain.writeOffBody, quantity: '2.000000' }),
        request(app.getHttpServer())
          .post(`/projects/${domain.project.id}/inventory/write-offs`)
          .set('Authorization', `Bearer ${domain.token}`)
          .set('Idempotency-Key', key)
          .send({ ...domain.writeOffBody, quantity: '2.000000' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect(a.body.id).toBe(b.body.id);
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
        await prisma.client.postedOperation.count({
          where: {
            projectId: domain.project.id,
            kind: 'stock_write_off.create',
          },
        }),
      ).toBe(1);
      await assertProjectCounts(domain.project.id, {
        movements: 2,
        operations: 2,
      });
    } finally {
      await deleteTestProject(prisma.client, domain.project.id);
    }
  }, 20_000);

  it('two concurrent write-offs cannot overdraw the same stock', async () => {
    const domain = await setupStock();
    try {
      const responses = await Promise.all(
        [idem(), idem()].map((key) =>
          request(app.getHttpServer())
            .post(`/projects/${domain.project.id}/inventory/write-offs`)
            .set('Authorization', `Bearer ${domain.token}`)
            .set('Idempotency-Key', key)
            .send(domain.writeOffBody),
        ),
      );
      expect(
        responses.filter((response) => response.status === 201),
      ).toHaveLength(1);
      for (const failed of responses.filter(
        (response) => response.status !== 201,
      )) {
        expect(failed.status).toBe(409);
        expect(['INSUFFICIENT_STOCK', 'CONCURRENT_MODIFICATION']).toContain(
          failed.body.code,
        );
      }
      const balance = await prisma.client.inventoryBalance.findUniqueOrThrow({
        where: {
          warehouseId_materialId: {
            warehouseId: domain.source.id,
            materialId: domain.material.id,
          },
        },
      });
      expect(balance.quantity.toFixed(6)).toBe('4.000000');
      expect(balance.valueUzs.toFixed(8)).toBe('400.00000000');
      await assertProjectCounts(domain.project.id, {
        movements: 2,
        operations: 2,
      });
    } finally {
      await deleteTestProject(prisma.client, domain.project.id);
    }
  }, 20_000);

  it('concurrent duplicate transfers have one paired business effect', async () => {
    const domain = await setupStock();
    try {
      const key = idem();
      const requests = [0, 1].map(() =>
        request(app.getHttpServer())
          .post(`/projects/${domain.project.id}/inventory/transfers`)
          .set('Authorization', `Bearer ${domain.token}`)
          .set('Idempotency-Key', key)
          .send({ ...domain.transferBody, quantity: '4.000000' }),
      );
      const [a, b] = await Promise.all(requests);
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect(a.body.id).toBe(b.body.id);
      const destination =
        await prisma.client.inventoryBalance.findUniqueOrThrow({
          where: {
            warehouseId_materialId: {
              warehouseId: domain.destination.id,
              materialId: domain.material.id,
            },
          },
        });
      expect(destination.quantity.toFixed(6)).toBe('4.000000');
      expect(destination.valueUzs.toFixed(8)).toBe('400.00000000');
      expect(
        await prisma.client.warehouseTransfer.count({
          where: { projectId: domain.project.id },
        }),
      ).toBe(1);
      await assertProjectCounts(domain.project.id, {
        movements: 3,
        operations: 2,
      });
    } finally {
      await deleteTestProject(prisma.client, domain.project.id);
    }
  }, 20_000);

  it('concurrent transfers cannot jointly overdraw their source', async () => {
    const domain = await setupStock();
    try {
      const responses = await Promise.all(
        [idem(), idem()].map((key) =>
          request(app.getHttpServer())
            .post(`/projects/${domain.project.id}/inventory/transfers`)
            .set('Authorization', `Bearer ${domain.token}`)
            .set('Idempotency-Key', key)
            .send(domain.transferBody),
        ),
      );
      expect(
        responses.filter((response) => response.status === 201),
      ).toHaveLength(1);
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
      expect(source.quantity.toFixed(6)).toBe('4.000000');
      expect(source.valueUzs.toFixed(8)).toBe('400.00000000');
      expect(destination.quantity.toFixed(6)).toBe('6.000000');
      expect(destination.valueUzs.toFixed(8)).toBe('600.00000000');
      await assertProjectCounts(domain.project.id, {
        movements: 3,
        operations: 2,
      });
    } finally {
      await deleteTestProject(prisma.client, domain.project.id);
    }
  }, 20_000);

  it('write-off versus transfer serializes with no negative stock or lost update', async () => {
    const domain = await setupStock();
    try {
      const [writeOff, transfer] = await Promise.all([
        request(app.getHttpServer())
          .post(`/projects/${domain.project.id}/inventory/write-offs`)
          .set('Authorization', `Bearer ${domain.token}`)
          .set('Idempotency-Key', idem())
          .send(domain.writeOffBody),
        request(app.getHttpServer())
          .post(`/projects/${domain.project.id}/inventory/transfers`)
          .set('Authorization', `Bearer ${domain.token}`)
          .set('Idempotency-Key', idem())
          .send(domain.transferBody),
      ]);
      expect(
        [writeOff, transfer].filter((response) => response.status === 201),
      ).toHaveLength(1);
      const source = await prisma.client.inventoryBalance.findUniqueOrThrow({
        where: {
          warehouseId_materialId: {
            warehouseId: domain.source.id,
            materialId: domain.material.id,
          },
        },
      });
      expect(source.quantity.toFixed(6)).toBe('4.000000');
      expect(source.valueUzs.toFixed(8)).toBe('400.00000000');
      const transferWon = transfer.status === 201;
      expect(
        await prisma.client.inventoryBalance.count({
          where: {
            projectId: domain.project.id,
            warehouseId: domain.destination.id,
            materialId: domain.material.id,
          },
        }),
      ).toBe(transferWon ? 1 : 0);
      await assertProjectCounts(domain.project.id, {
        movements: transferWon ? 3 : 2,
        operations: 2,
      });
    } finally {
      await deleteTestProject(prisma.client, domain.project.id);
    }
  }, 20_000);

  it('purchase cancellation versus write-off commits exactly one compatible outcome', async () => {
    const domain = await setupStock();
    try {
      const [cancellation, writeOff] = await Promise.all([
        request(app.getHttpServer())
          .post(
            `/projects/${domain.project.id}/purchases/${domain.purchase.body.id}/cancel`,
          )
          .set('Authorization', `Bearer ${domain.token}`)
          .set('Idempotency-Key', idem())
          .send({ reason: 'Concurrent correction' }),
        request(app.getHttpServer())
          .post(`/projects/${domain.project.id}/inventory/write-offs`)
          .set('Authorization', `Bearer ${domain.token}`)
          .set('Idempotency-Key', idem())
          .send({ ...domain.writeOffBody, quantity: '2.000000' }),
      ]);
      expect(
        [cancellation, writeOff].filter((response) => response.status < 300),
      ).toHaveLength(1);
      const balance = await prisma.client.inventoryBalance.findUniqueOrThrow({
        where: {
          warehouseId_materialId: {
            warehouseId: domain.source.id,
            materialId: domain.material.id,
          },
        },
      });
      if (cancellation.status === 200) {
        expect(balance.quantity.toFixed(6)).toBe('0.000000');
        expect(balance.valueUzs.toFixed(8)).toBe('0.00000000');
      } else {
        expect(writeOff.status).toBe(201);
        expect(balance.quantity.toFixed(6)).toBe('8.000000');
        expect(balance.valueUzs.toFixed(8)).toBe('800.00000000');
      }
      await assertProjectCounts(domain.project.id, {
        movements: 2,
        operations: 2,
      });
    } finally {
      await deleteTestProject(prisma.client, domain.project.id);
    }
  }, 20_000);
});
