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

/**
 * The full orchestrated purchase workflow (transaction-design.md §4) end to
 * end through the real HTTP API — the most important business workflow in
 * this system (this phase's own framing).
 */
describe('Purchases (e2e)', () => {
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
      `Purchase Test ${randomUUID()}`,
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
    return { category, unit, warehouse, material, supplier };
  }

  async function fundCash(
    projectId: string,
    token: string,
    amount: string,
    currency = 'UZS',
  ) {
    await request(app.getHttpServer())
      .post(`/projects/${projectId}/finances`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idem())
      .send({
        type: 'INCOME',
        amount,
        currency,
        source: 'x',
        occurredAt: '2026-09-14',
      })
      .expect(201);
  }

  // -----------------------------------------------------------------
  // Happy paths — funding mixes
  // -----------------------------------------------------------------
  describe('Creating a purchase', () => {
    it('a fully cash-paid purchase receives stock, posts one cash transaction, and is PAID', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const { warehouse, material, supplier } = await setupCatalog(
          project.id,
        );
        await fundCash(project.id, token, '100000000.00');

        const created = await request(app.getHttpServer())
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
                unitPrice: '75000.00000000',
              },
            ],
            cashPaid: '15000000.00',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        expect(created.body.totalAmount).toBe('15000000.00');
        expect(created.body.totalAmountUzs).toBe('15000000.00');
        expect(created.body.remainingDebt).toBe('0.00');
        expect(created.body.status).toBe('PAID');
        expect(created.body.items).toHaveLength(1);
        expect(created.body.items[0].lineAmountUzs).toBe('15000000.00');

        const balance = await prisma.client.inventoryBalance.findUnique({
          where: {
            warehouseId_materialId: {
              warehouseId: warehouse.id,
              materialId: material.id,
            },
          },
        });
        expect(balance?.quantity.toFixed(6)).toBe('200.000000');
        expect(balance?.valueUzs.toFixed(8)).toBe('15000000.00000000');

        const txCount = await prisma.client.financialTransaction.count({
          where: { projectId: project.id, type: 'PURCHASE' },
        });
        expect(txCount).toBe(1);

        const cashBalance = await request(app.getHttpServer())
          .get(`/projects/${project.id}/finances/balance`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(cashBalance.body.uzs).toBe('85000000.00');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('a zero-cash, no-advance purchase creates no SupplierPayment/FinancialTransaction row (§17)', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const { warehouse, material, supplier } = await setupCatalog(
          project.id,
        );

        const created = await request(app.getHttpServer())
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
                quantity: '10.000000',
                unitPrice: '1000.00000000',
              },
            ],
            occurredAt: '2026-09-14',
          })
          .expect(201);

        expect(created.body.remainingDebt).toBe('10000.00');
        expect(created.body.status).toBe('UNPAID');

        const txCount = await prisma.client.financialTransaction.count({
          where: { projectId: project.id },
        });
        expect(txCount).toBe(0);
        const paymentCount = await prisma.client.supplierPayment.count({
          where: { projectId: project.id },
        });
        expect(paymentCount).toBe(0);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('a partially cash-paid purchase is PARTIALLY_PAID with the exact remaining debt', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const { warehouse, material, supplier } = await setupCatalog(
          project.id,
        );
        await fundCash(project.id, token, '100000000.00');

        const created = await request(app.getHttpServer())
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
                unitPrice: '100000.00000000',
              },
            ],
            cashPaid: '4000000.00',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        expect(created.body.totalAmount).toBe('10000000.00');
        expect(created.body.remainingDebt).toBe('6000000.00');
        expect(created.body.status).toBe('PARTIALLY_PAID');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('a fully advance-funded purchase is PAID with no PURCHASE-type FinancialTransaction ever created', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const { warehouse, material, supplier } = await setupCatalog(
          project.id,
        );
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

        const created = await request(app.getHttpServer())
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
                unitPrice: '100000.00000000',
              },
            ],
            advanceAllocations: [
              { advanceId: advance.body.id, amount: '20000000.00' },
            ],
            occurredAt: '2026-09-14',
          })
          .expect(201);

        expect(created.body.totalAmount).toBe('20000000.00');
        expect(created.body.remainingDebt).toBe('0.00');
        expect(created.body.status).toBe('PAID');

        // Only the advance-FUNDING transaction exists — never a PURCHASE one.
        const purchaseTxCount = await prisma.client.financialTransaction.count({
          where: { projectId: project.id, type: 'PURCHASE' },
        });
        expect(purchaseTxCount).toBe(0);
        const advanceTxCount = await prisma.client.financialTransaction.count({
          where: { projectId: project.id, type: 'ADVANCE' },
        });
        expect(advanceTxCount).toBe(1);

        const consumed = await prisma.client.settlementAllocation.aggregate({
          where: { advanceId: advance.body.id, effect: 'APPLY' },
          _sum: { settlementAmount: true },
        });
        expect(consumed._sum.settlementAmount?.toFixed(2)).toBe('20000000.00');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('a mixed advance + cash purchase settles both exactly against the invoice total', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const { warehouse, material, supplier } = await setupCatalog(
          project.id,
        );
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

        const created = await request(app.getHttpServer())
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
                quantity: '300.000000',
                unitPrice: '100000.00000000',
              },
            ],
            advanceAllocations: [
              { advanceId: advance.body.id, amount: '20000000.00' },
            ],
            cashPaid: '5000000.00',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        expect(created.body.totalAmount).toBe('30000000.00');
        expect(created.body.remainingDebt).toBe('5000000.00');
        expect(created.body.status).toBe('PARTIALLY_PAID');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('weighted average cost accumulates correctly across two purchases of the same material', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const { warehouse, material, supplier } = await setupCatalog(
          project.id,
        );

        await request(app.getHttpServer())
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
          })
          .expect(201);

        await request(app.getHttpServer())
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
          })
          .expect(201);

        const balance = await prisma.client.inventoryBalance.findUnique({
          where: {
            warehouseId_materialId: {
              warehouseId: warehouse.id,
              materialId: material.id,
            },
          },
        });
        // 100*70000 + 200*80000 = 23,000,000 over 300 units (the
        // specification's own worked example).
        expect(balance?.quantity.toFixed(6)).toBe('300.000000');
        expect(balance?.valueUzs.toFixed(8)).toBe('23000000.00000000');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('distributes the UZS total across many lines exactly (largest-remainder), summing to the invoice total', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const category = await createTestMaterialCategory(
          prisma.client,
          project.id,
        );
        const unit = await createTestUnit(prisma.client, project.id);
        const warehouse = await createTestWarehouse(prisma.client, project.id);
        const supplier = await createTestSupplier(prisma.client, project.id);
        const materials = await Promise.all(
          Array.from({ length: 3 }, () =>
            createTestMaterial(prisma.client, project.id, category.id, unit.id),
          ),
        );

        const created = await request(app.getHttpServer())
          .post(`/projects/${project.id}/purchases`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            supplierId: supplier.id,
            warehouseId: warehouse.id,
            currency: 'USD',
            exchangeRate: '12345.67000000',
            rateOverrideReason: 'test rate',
            items: materials.map((m) => ({
              materialId: m.id,
              quantity: '1.000000',
              unitPrice: '33.33333333',
            })),
            occurredAt: '2026-09-14',
          })
          .expect(201);

        const sumUzs = created.body.items.reduce(
          (sum: number, item: { lineAmountUzs: string }) =>
            sum + Number(item.lineAmountUzs),
          0,
        );
        expect(sumUzs.toFixed(2)).toBe(created.body.totalAmountUzs);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });

  // -----------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------
  describe('Validation', () => {
    it('rejects duplicate material lines', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const { warehouse, material, supplier } = await setupCatalog(
          project.id,
        );
        const res = await request(app.getHttpServer())
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
                quantity: '1.000000',
                unitPrice: '1.00000000',
              },
              {
                materialId: material.id,
                quantity: '2.000000',
                unitPrice: '1.00000000',
              },
            ],
            occurredAt: '2026-09-14',
          })
          .expect(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects an unknown material with 404', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const { warehouse, supplier } = await setupCatalog(project.id);
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/purchases`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            supplierId: supplier.id,
            warehouseId: warehouse.id,
            currency: 'UZS',
            items: [
              {
                materialId: randomUUID(),
                quantity: '1.000000',
                unitPrice: '1.00000000',
              },
            ],
            occurredAt: '2026-09-14',
          })
          .expect(404);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects a material belonging to a different project (composite-FK scoped lookup)', async () => {
      const { project, token } = await setupProjectAndManager();
      const other = await createTestProject(
        prisma.client,
        `Other ${randomUUID()}`,
      );
      try {
        const { warehouse, supplier } = await setupCatalog(project.id);
        const otherCategory = await createTestMaterialCategory(
          prisma.client,
          other.id,
        );
        const otherUnit = await createTestUnit(prisma.client, other.id);
        const foreignMaterial = await createTestMaterial(
          prisma.client,
          other.id,
          otherCategory.id,
          otherUnit.id,
        );
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/purchases`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            supplierId: supplier.id,
            warehouseId: warehouse.id,
            currency: 'UZS',
            items: [
              {
                materialId: foreignMaterial.id,
                quantity: '1.000000',
                unitPrice: '1.00000000',
              },
            ],
            occurredAt: '2026-09-14',
          })
          .expect(404);
      } finally {
        await deleteTestProject(prisma.client, project.id);
        await deleteTestProject(prisma.client, other.id);
      }
    });

    it('rejects cash exceeding the available balance with 409 INSUFFICIENT_CASH', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const { warehouse, material, supplier } = await setupCatalog(
          project.id,
        );
        const res = await request(app.getHttpServer())
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
                quantity: '1.000000',
                unitPrice: '1000.00000000',
              },
            ],
            cashPaid: '1000.00',
            occurredAt: '2026-09-14',
          })
          .expect(409);
        expect(res.body.code).toBe('INSUFFICIENT_CASH');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects settling more than the advance has available with 409 ADVANCE_EXCEEDS_AVAILABLE', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const { warehouse, material, supplier } = await setupCatalog(
          project.id,
        );
        await fundCash(project.id, token, '100000000.00');
        const advance = await request(app.getHttpServer())
          .post(`/projects/${project.id}/suppliers/${supplier.id}/advances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            currency: 'UZS',
            amount: '5000000.00',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        const res = await request(app.getHttpServer())
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
                unitPrice: '100000.00000000',
              },
            ],
            advanceAllocations: [
              { advanceId: advance.body.id, amount: '6000000.00' },
            ],
            occurredAt: '2026-09-14',
          })
          .expect(409);
        expect(res.body.code).toBe('ADVANCE_EXCEEDS_AVAILABLE');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects a future occurredAt', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const { warehouse, material, supplier } = await setupCatalog(
          project.id,
        );
        await request(app.getHttpServer())
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
                quantity: '1.000000',
                unitPrice: '1.00000000',
              },
            ],
            occurredAt: '2099-01-01',
          })
          .expect(400);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });

  // -----------------------------------------------------------------
  // Authorization
  // -----------------------------------------------------------------
  describe('Authorization', () => {
    it('OWNER/ACCOUNTANT can read but not create purchases', async () => {
      const { project } = await setupProjectAndManager();
      const owner = await createTestUser(prisma.client, { role: Role.OWNER });
      try {
        const { warehouse, material, supplier } = await setupCatalog(
          project.id,
        );
        const token = await loginTestUser(app.getHttpServer(), owner.email);
        await request(app.getHttpServer())
          .get(`/projects/${project.id}/purchases`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        await request(app.getHttpServer())
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
                quantity: '1.000000',
                unitPrice: '1.00000000',
              },
            ],
            occurredAt: '2026-09-14',
          })
          .expect(403);
      } finally {
        await deleteTestUser(prisma.client, owner.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('a manager of a different project cannot post into this project', async () => {
      const { project } = await setupProjectAndManager();
      const other = await setupProjectAndManager();
      try {
        const { warehouse, material, supplier } = await setupCatalog(
          project.id,
        );
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/purchases`)
          .set('Authorization', `Bearer ${other.token}`)
          .set('Idempotency-Key', idem())
          .send({
            supplierId: supplier.id,
            warehouseId: warehouse.id,
            currency: 'UZS',
            items: [
              {
                materialId: material.id,
                quantity: '1.000000',
                unitPrice: '1.00000000',
              },
            ],
            occurredAt: '2026-09-14',
          })
          .expect(403);
      } finally {
        await deleteTestProject(prisma.client, project.id);
        await deleteTestProject(prisma.client, other.project.id);
      }
    });
  });

  // -----------------------------------------------------------------
  // Idempotency
  // -----------------------------------------------------------------
  describe('Idempotency', () => {
    it('replays the same result for a repeated key+body, and 409s on key reuse with a different body', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const { warehouse, material, supplier } = await setupCatalog(
          project.id,
        );
        const key = idem();
        const body = {
          supplierId: supplier.id,
          warehouseId: warehouse.id,
          currency: 'UZS',
          items: [
            {
              materialId: material.id,
              quantity: '1.000000',
              unitPrice: '1000.00000000',
            },
          ],
          occurredAt: '2026-09-14',
        };

        const first = await request(app.getHttpServer())
          .post(`/projects/${project.id}/purchases`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', key)
          .send(body)
          .expect(201);

        const replay = await request(app.getHttpServer())
          .post(`/projects/${project.id}/purchases`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', key)
          .send(body)
          .expect(200);
        expect(replay.body.id).toBe(first.body.id);

        const count = await prisma.client.purchase.count({
          where: { projectId: project.id },
        });
        expect(count).toBe(1);

        const conflict = await request(app.getHttpServer())
          .post(`/projects/${project.id}/purchases`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', key)
          .send({
            ...body,
            items: [{ ...body.items[0], quantity: '2.000000' }],
          })
          .expect(409);
        expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });

  // -----------------------------------------------------------------
  // Comment editing (the only mutable field on a posted purchase)
  // -----------------------------------------------------------------
  describe('Comment editing', () => {
    it('PATCH changes only the comment', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const { warehouse, material, supplier } = await setupCatalog(
          project.id,
        );
        const created = await request(app.getHttpServer())
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
                quantity: '1.000000',
                unitPrice: '1000.00000000',
              },
            ],
            occurredAt: '2026-09-14',
          })
          .expect(201);

        const patched = await request(app.getHttpServer())
          .patch(`/projects/${project.id}/purchases/${created.body.id}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ comment: 'Corrected after review' })
          .expect(200);
        expect(patched.body.comment).toBe('Corrected after review');
        expect(patched.body.totalAmount).toBe(created.body.totalAmount);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });

  // -----------------------------------------------------------------
  // Cancellation
  // -----------------------------------------------------------------
  describe('Cancellation', () => {
    it('cancelling a cash purchase restores stock to zero and refunds the cash', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const { warehouse, material, supplier } = await setupCatalog(
          project.id,
        );
        await fundCash(project.id, token, '100000000.00');

        const created = await request(app.getHttpServer())
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
                quantity: '50.000000',
                unitPrice: '100000.00000000',
              },
            ],
            cashPaid: '5000000.00',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        const cancelled = await request(app.getHttpServer())
          .post(`/projects/${project.id}/purchases/${created.body.id}/cancel`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({ reason: 'Duplicate entry — posted twice' })
          .expect(200);
        expect(cancelled.body.status).toBe('CANCELLED');
        expect(cancelled.body.cancellationReason).toBe(
          'Duplicate entry — posted twice',
        );

        const balance = await prisma.client.inventoryBalance.findUnique({
          where: {
            warehouseId_materialId: {
              warehouseId: warehouse.id,
              materialId: material.id,
            },
          },
        });
        expect(balance?.quantity.toFixed(6)).toBe('0.000000');
        expect(balance?.valueUzs.toFixed(8)).toBe('0.00000000');

        const cashBalance = await request(app.getHttpServer())
          .get(`/projects/${project.id}/finances/balance`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(cashBalance.body.uzs).toBe('100000000.00');

        // Cancelling again is rejected.
        const again = await request(app.getHttpServer())
          .post(`/projects/${project.id}/purchases/${created.body.id}/cancel`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({ reason: 'again' })
          .expect(409);
        expect(again.body.code).toBe('PURCHASE_ALREADY_CANCELLED');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('blocks cancellation once a later purchase has built on the same balance, then allows it once that later purchase is itself cancelled', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const { warehouse, material, supplier } = await setupCatalog(
          project.id,
        );

        const first = await request(app.getHttpServer())
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
                unitPrice: '1000.00000000',
              },
            ],
            occurredAt: '2026-09-14',
          })
          .expect(201);

        const second = await request(app.getHttpServer())
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
                quantity: '50.000000',
                unitPrice: '2000.00000000',
              },
            ],
            occurredAt: '2026-09-14',
          })
          .expect(201);

        const blocked = await request(app.getHttpServer())
          .post(`/projects/${project.id}/purchases/${first.body.id}/cancel`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({ reason: 'try to cancel the earlier one' })
          .expect(409);
        expect(blocked.body.code).toBe('PURCHASE_HAS_DEPENDENT_MOVEMENTS');

        await request(app.getHttpServer())
          .post(`/projects/${project.id}/purchases/${second.body.id}/cancel`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({ reason: 'cancel the later one first' })
          .expect(200);

        await request(app.getHttpServer())
          .post(`/projects/${project.id}/purchases/${first.body.id}/cancel`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({ reason: 'now the earlier one can be cancelled' })
          .expect(200);

        const balance = await prisma.client.inventoryBalance.findUnique({
          where: {
            warehouseId_materialId: {
              warehouseId: warehouse.id,
              materialId: material.id,
            },
          },
        });
        expect(balance?.quantity.toFixed(6)).toBe('0.000000');
        expect(balance?.valueUzs.toFixed(8)).toBe('0.00000000');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('blocks cancellation while a later debt payment is still in effect against the purchase', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const { warehouse, material, supplier } = await setupCatalog(
          project.id,
        );

        const created = await request(app.getHttpServer())
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
                unitPrice: '100000.00000000',
              },
            ],
            occurredAt: '2026-09-14',
          })
          .expect(201);

        await fundCash(project.id, token, '100000000.00');
        await request(app.getHttpServer())
          .post(
            `/projects/${project.id}/suppliers/${supplier.id}/debt-payments`,
          )
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            purchaseId: created.body.id,
            currency: 'UZS',
            amount: '5000000.00',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        const blocked = await request(app.getHttpServer())
          .post(`/projects/${project.id}/purchases/${created.body.id}/cancel`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({ reason: 'try to cancel after a debt payment' })
          .expect(409);
        expect(blocked.body.code).toBe('PURCHASE_HAS_DEPENDENT_MOVEMENTS');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });
});
