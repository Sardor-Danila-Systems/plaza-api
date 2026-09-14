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

/**
 * Real concurrent load against the purchase workflow's project-lock
 * protocol — the same discipline as test/suppliers-concurrency.e2e-spec.ts
 * and test/finances-concurrency.e2e-spec.ts.
 */
describe('Purchases concurrency (e2e)', () => {
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

  afterAll(async () => {
    await app.close();
  });

  function idem(): string {
    return randomUUID();
  }

  async function setupProjectAndManager() {
    const project = await createTestProject(
      prisma.client,
      `Purchase Concurrency Test ${randomUUID()}`,
    );
    const manager = await createTestUser(prisma.client, {
      role: Role.PROJECT_MANAGER,
      projectId: project.id,
    });
    const token = await loginTestUser(app.getHttpServer(), manager.email);
    return { project, manager, token };
  }

  async function setupCatalog(projectId: string) {
    const category = await createTestMaterialCategory(prisma.client, projectId);
    const unit = await createTestUnit(prisma.client, projectId);
    const warehouse = await createTestWarehouse(prisma.client, projectId);
    const material = await createTestMaterial(
      prisma.client,
      projectId,
      category.id,
      unit.id,
    );
    const supplier = await createTestSupplier(prisma.client, projectId);
    return { warehouse, material, supplier };
  }

  async function fundCash(projectId: string, token: string, amount: string) {
    await request(app.getHttpServer())
      .post(`/projects/${projectId}/finances`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idem())
      .send({
        type: 'INCOME',
        amount,
        currency: 'UZS',
        source: 'x',
        occurredAt: '2026-09-14',
      })
      .expect(201);
  }

  it('a duplicate purchase-creation request (same Idempotency-Key, fired concurrently) posts exactly once', async () => {
    const { project, token } = await setupProjectAndManager();
    try {
      const { warehouse, material, supplier } = await setupCatalog(project.id);
      const key = idem();
      const body = {
        supplierId: supplier.id,
        warehouseId: warehouse.id,
        currency: 'UZS',
        items: [
          {
            materialId: material.id,
            quantity: '10.000000',
            unitPrice: '1000.00000000',
          },
        ],
        occurredAt: '2026-09-14',
      };

      const [a, b] = await Promise.all([
        request(app.getHttpServer())
          .post(`/projects/${project.id}/purchases`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', key)
          .send(body),
        request(app.getHttpServer())
          .post(`/projects/${project.id}/purchases`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', key)
          .send(body),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 201]);
      expect(a.body.id).toBe(b.body.id);

      const count = await prisma.client.purchase.count({
        where: { projectId: project.id },
      });
      expect(count).toBe(1);
      const balance = await prisma.client.inventoryBalance.findUnique({
        where: {
          warehouseId_materialId: {
            warehouseId: warehouse.id,
            materialId: material.id,
          },
        },
      });
      expect(balance?.quantity.toFixed(6)).toBe('10.000000');
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  }, 20000);

  it('two concurrent purchases racing to consume the same advance never over-consume it', async () => {
    const { project, token } = await setupProjectAndManager();
    try {
      const { warehouse, material, supplier } = await setupCatalog(project.id);
      await fundCash(project.id, token, '100000000.00');
      const advance = await request(app.getHttpServer())
        .post(`/projects/${project.id}/suppliers/${supplier.id}/advances`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idem())
        .send({
          currency: 'UZS',
          amount: '20000000.00',
          occurredAt: '2026-09-14',
        })
        .expect(201);

      const purchaseBody = {
        supplierId: supplier.id,
        warehouseId: warehouse.id,
        currency: 'UZS',
        items: [
          {
            materialId: material.id,
            quantity: '150.000000',
            unitPrice: '100000.00000000',
          },
        ],
        advanceAllocations: [
          { advanceId: advance.body.id, amount: '15000000.00' },
        ],
        occurredAt: '2026-09-14',
      };

      const [a, b] = await Promise.all([
        request(app.getHttpServer())
          .post(`/projects/${project.id}/purchases`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send(purchaseBody),
        request(app.getHttpServer())
          .post(`/projects/${project.id}/purchases`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send(purchaseBody),
      ]);

      // Same tolerance as the cash-overdraw test below: the loser may
      // legitimately exhaust its retry budget as `409
      // CONCURRENT_MODIFICATION` instead of reaching the advance-balance
      // check to fail as `409 ADVANCE_EXCEEDS_AVAILABLE` — both are correct
      // outcomes; the invariant is that the 20m advance is never
      // over-consumed by two 15m allocations.
      const succeeded = [a, b].filter((r) => r.status === 201);
      const failed = [a, b].filter((r) => r.status !== 201);
      expect(succeeded.length).toBeLessThanOrEqual(1);
      for (const response of failed) {
        expect(response.status).toBe(409);
        expect([
          'ADVANCE_EXCEEDS_AVAILABLE',
          'CONCURRENT_MODIFICATION',
        ]).toContain(response.body.code);
      }

      const consumed = await prisma.client.settlementAllocation.aggregate({
        where: { advanceId: advance.body.id, effect: 'APPLY' },
        _sum: { settlementAmount: true },
      });
      expect(consumed._sum.settlementAmount?.toFixed(2) ?? '0.00').toBe(
        succeeded.length === 1 ? '15000000.00' : '0.00',
      );
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  }, 20000);

  it('two concurrent cash-paid purchases never jointly overdraw the project balance', async () => {
    const { project, token } = await setupProjectAndManager();
    try {
      const { warehouse, material, supplier } = await setupCatalog(project.id);
      await fundCash(project.id, token, '10000000.00');

      const purchaseBody = {
        supplierId: supplier.id,
        warehouseId: warehouse.id,
        currency: 'UZS',
        items: [
          {
            materialId: material.id,
            quantity: '100.000000',
            unitPrice: '100000.00000000',
          },
        ],
        cashPaid: '8000000.00',
        occurredAt: '2026-09-14',
      };

      const [a, b] = await Promise.all([
        request(app.getHttpServer())
          .post(`/projects/${project.id}/purchases`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send(purchaseBody),
        request(app.getHttpServer())
          .post(`/projects/${project.id}/purchases`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send(purchaseBody),
      ]);

      // The cash-sufficiency invariant is that at most one of the two 8m
      // payments against a 10m balance can ever succeed — never both. Under
      // heavy same-row contention the loser may also legitimately exhaust
      // the retry budget as `409 CONCURRENT_MODIFICATION` rather than
      // reaching the balance check to fail as `409 INSUFFICIENT_CASH`; both
      // are correct outcomes of the same protocol (transaction-design.md
      // §2), so this asserts the invariant rather than one fixed status
      // pairing.
      const succeeded = [a, b].filter((r) => r.status === 201);
      const failed = [a, b].filter((r) => r.status !== 201);
      expect(succeeded.length).toBeLessThanOrEqual(1);
      for (const response of failed) {
        expect(response.status).toBe(409);
        expect(['INSUFFICIENT_CASH', 'CONCURRENT_MODIFICATION']).toContain(
          response.body.code,
        );
      }

      const balance = await request(app.getHttpServer())
        .get(`/projects/${project.id}/finances/balance`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(Number(balance.body.uzs)).toBeGreaterThanOrEqual(0);
      expect(balance.body.uzs).toBe(
        succeeded.length === 1 ? '2000000.00' : '10000000.00',
      );
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  }, 20000);

  it('two first-receipts of the same material racing into the same balance land on one consistent (quantity, value) pair', async () => {
    const { project, token } = await setupProjectAndManager();
    try {
      const { warehouse, material, supplier } = await setupCatalog(project.id);

      const [a, b] = await Promise.all([
        request(app.getHttpServer())
          .post(`/projects/${project.id}/purchases`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            supplierId: supplier.id,
            warehouseId: warehouse.id,
            currency: 'UZS',
            items: [
              {
                materialId: material.id,
                quantity: '100.000000',
                unitPrice: '70000.00000000',
              },
            ],
            occurredAt: '2026-09-14',
          }),
        request(app.getHttpServer())
          .post(`/projects/${project.id}/purchases`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            supplierId: supplier.id,
            warehouseId: warehouse.id,
            currency: 'UZS',
            items: [
              {
                materialId: material.id,
                quantity: '200.000000',
                unitPrice: '80000.00000000',
              },
            ],
            occurredAt: '2026-09-14',
          }),
      ]);

      expect(a.status).toBe(201);
      expect(b.status).toBe(201);

      const balance = await prisma.client.inventoryBalance.findUnique({
        where: {
          warehouseId_materialId: {
            warehouseId: warehouse.id,
            materialId: material.id,
          },
        },
      });
      expect(balance?.quantity.toFixed(6)).toBe('300.000000');
      expect(balance?.valueUzs.toFixed(8)).toBe('23000000.00000000');
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  }, 20000);
});
