import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Role } from '../src/generated/prisma/client.js';
import { setupApp } from '../src/setup-app.js';
import {
  createTestProject,
  createTestPurchase,
  createTestSupplier,
  createTestUser,
  createTestWarehouse,
  deleteTestProject,
  loginTestUser,
} from './fixtures/auth.fixture.js';

/**
 * Real concurrent load against the project-lock protocol for Phase 6's own
 * workflows — the same discipline as test/finances-concurrency.e2e-spec.ts.
 */
describe('Suppliers concurrency (e2e)', () => {
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

  async function setupProjectAndManager() {
    const project = await createTestProject(
      prisma.client,
      `Supplier Concurrency Test ${randomUUID()}`,
    );
    const manager = await createTestUser(prisma.client, {
      role: Role.PROJECT_MANAGER,
      projectId: project.id,
    });
    const token = await loginTestUser(app.getHttpServer(), manager.email);
    return { project, manager, token };
  }

  it('two concurrent debt payments against the same purchase never overpay it', async () => {
    const { project, manager, token } = await setupProjectAndManager();
    try {
      await request(app.getHttpServer())
        .post(`/projects/${project.id}/finances`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          type: 'INCOME',
          amount: '50000000.00',
          currency: 'UZS',
          source: 'x',
          occurredAt: '2026-09-14',
        })
        .expect(201);

      const supplier = await createTestSupplier(prisma.client, project.id);
      const warehouse = await createTestWarehouse(prisma.client, project.id);
      const purchase = await createTestPurchase(
        prisma.client,
        project.id,
        supplier.id,
        warehouse.id,
        manager.id,
        {
          currency: 'UZS',
          totalAmount: '10000000.00',
        },
      );

      const [a, b] = await Promise.all([
        request(app.getHttpServer())
          .post(
            `/projects/${project.id}/suppliers/${supplier.id}/debt-payments`,
          )
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', randomUUID())
          .send({
            purchaseId: purchase.id,
            currency: 'UZS',
            amount: '8000000.00',
            occurredAt: '2026-09-14',
          }),
        request(app.getHttpServer())
          .post(
            `/projects/${project.id}/suppliers/${supplier.id}/debt-payments`,
          )
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', randomUUID())
          .send({
            purchaseId: purchase.id,
            currency: 'UZS',
            amount: '8000000.00',
            occurredAt: '2026-09-14',
          }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);
      const rejected = a.status === 409 ? a : b;
      expect(rejected.body.code).toBe('DEBT_PAYMENT_EXCEEDS_REMAINING');

      const allocations = await prisma.client.settlementAllocation.count({
        where: { purchaseId: purchase.id },
      });
      expect(allocations).toBe(1);

      const totalSettled = await prisma.client.settlementAllocation.aggregate({
        where: { purchaseId: purchase.id },
        _sum: { debtAmountSettled: true },
      });
      expect(totalSettled._sum.debtAmountSettled?.toFixed(2)).toBe(
        '8000000.00',
      );
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  }, 20000);

  it('two concurrent advance-funding requests never overdraw cash', async () => {
    const { project, token } = await setupProjectAndManager();
    try {
      await request(app.getHttpServer())
        .post(`/projects/${project.id}/finances`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          type: 'INCOME',
          amount: '10000000.00',
          currency: 'UZS',
          source: 'x',
          occurredAt: '2026-09-14',
        })
        .expect(201);

      const supplier = await createTestSupplier(prisma.client, project.id);

      const [a, b] = await Promise.all([
        request(app.getHttpServer())
          .post(`/projects/${project.id}/suppliers/${supplier.id}/advances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', randomUUID())
          .send({
            currency: 'UZS',
            amount: '8000000.00',
            occurredAt: '2026-09-14',
          }),
        request(app.getHttpServer())
          .post(`/projects/${project.id}/suppliers/${supplier.id}/advances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', randomUUID())
          .send({
            currency: 'UZS',
            amount: '8000000.00',
            occurredAt: '2026-09-14',
          }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);

      const balance = await request(app.getHttpServer())
        .get(`/projects/${project.id}/finances/balance`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(Number(balance.body.uzs)).toBeGreaterThanOrEqual(0);
      expect(balance.body.uzs).toBe('2000000.00');
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  }, 20000);
});
