import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Role } from '../src/generated/prisma/client.js';
import { setupApp } from '../src/setup-app.js';
import {
  createTestBlock,
  createTestFloor,
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
 * Phase 10 — analytics computed directly from the authoritative ledger/
 * projection tables (docs/backend-architecture.md §11). One deterministic
 * worked scenario, queried at several different `to` cutoffs, to prove the
 * "as of `to`" reconstruction is real (not just a current-state read) and
 * that `current` is always returned alongside a historical `to`.
 */
describe('Analytics (e2e)', () => {
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
      `Analytics Test ${randomUUID()}`,
    );
    const manager = await createTestUser(prisma.client, {
      role: Role.PROJECT_MANAGER,
      projectId: project.id,
    });
    const token = await loginTestUser(app.getHttpServer(), manager.email);
    return { project, manager, token };
  }

  it('reconstructs cash/debt/inventory correctly at three different points in time, and always returns current alongside historical', async () => {
    const { project, token } = await setupProjectAndManager();
    try {
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
      const supplier = await createTestSupplier(prisma.client, project.id);
      const block = await createTestBlock(prisma.client, project.id);
      const floor = await createTestFloor(prisma.client, project.id, block.id);

      // 2026-09-01: fund 10,000,000 UZS.
      await request(app.getHttpServer())
        .post(`/projects/${project.id}/finances`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idem())
        .send({
          type: 'INCOME',
          amount: '10000000.00',
          currency: 'UZS',
          source: 'x',
          occurredAt: '2026-09-01',
        })
        .expect(201);

      // 2026-09-05: purchase 100 @ 50,000 = 5,000,000, cash 2,000,000.
      const purchase = await request(app.getHttpServer())
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
              unitPrice: '50000.00000000',
            },
          ],
          cashPaid: '2000000.00',
          occurredAt: '2026-09-05',
        })
        .expect(201);
      expect(purchase.body.totalAmount).toBe('5000000.00');

      // 2026-09-10: write off 30 units (1,500,000) to block/floor.
      await request(app.getHttpServer())
        .post(`/projects/${project.id}/inventory/write-offs`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idem())
        .send({
          warehouseId: warehouse.id,
          materialId: material.id,
          blockId: block.id,
          floorId: floor.id,
          quantity: '30.000000',
          occurredAt: '2026-09-10',
        })
        .expect(201);

      // 2026-09-15: pay down 1,000,000 of the remaining debt.
      await request(app.getHttpServer())
        .post(`/projects/${project.id}/suppliers/${supplier.id}/debt-payments`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idem())
        .send({
          purchaseId: purchase.body.id,
          currency: 'UZS',
          amount: '1000000.00',
          occurredAt: '2026-09-15',
        })
        .expect(201);

      // --- Full month view: everything has happened by dateTo. ---
      const full = await request(app.getHttpServer())
        .get(`/projects/${project.id}/analytics/summary`)
        .query({ dateFrom: '2026-09-01', dateTo: '2026-10-01' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(full.body.cashUzs.opening).toBe('0.00');
      expect(full.body.cashUzs.periodInflow).toBe('10000000.00');
      expect(full.body.cashUzs.periodOutflow).toBe('3000000.00'); // 2m purchase cash + 1m debt payment
      expect(full.body.cashUzs.closing).toBe('7000000.00');
      expect(full.body.cashUzs.current).toBe('7000000.00');
      expect(full.body.purchasesTotalUzs).toBe('5000000.00');
      expect(full.body.purchasesCount).toBe(1);
      expect(full.body.supplierDebtAsOf).toEqual([
        { currency: 'UZS', amount: '2000000.00' },
      ]); // 5m - 2m - 1m
      expect(full.body.inventoryValueAsOfUzs).toBe('3500000.00000000'); // 5m - 1.5m
      expect(full.body.currentInventoryValueUzs).toBe('3500000.00000000');
      expect(Number(full.body.postingSequenceCutoff)).toBeGreaterThan(0);

      // --- As of 2026-09-08: purchase happened, write-off and debt
      // payment have NOT. `current` must still reflect TODAY's real state,
      // not this historical cutoff. ---
      const midpoint = await request(app.getHttpServer())
        .get(`/projects/${project.id}/analytics/summary`)
        .query({ dateTo: '2026-09-08' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(midpoint.body.cashUzs.closing).toBe('8000000.00'); // 10m - 2m
      expect(midpoint.body.cashUzs.current).toBe('7000000.00'); // today's real balance
      expect(midpoint.body.supplierDebtAsOf).toEqual([
        { currency: 'UZS', amount: '3000000.00' },
      ]); // 5m - 2m
      expect(midpoint.body.inventoryValueAsOfUzs).toBe('5000000.00000000'); // write-off not yet posted
      expect(midpoint.body.currentInventoryValueUzs).toBe('3500000.00000000'); // today's real value

      // --- A later window: opening carries forward everything before it. ---
      const later = await request(app.getHttpServer())
        .get(`/projects/${project.id}/analytics/summary`)
        .query({ dateFrom: '2026-09-11', dateTo: '2026-10-01' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(later.body.cashUzs.opening).toBe('8000000.00'); // everything before 09-11
      expect(later.body.cashUzs.periodInflow).toBe('0.00');
      expect(later.body.cashUzs.periodOutflow).toBe('1000000.00'); // only the debt payment
      expect(later.body.cashUzs.closing).toBe('7000000.00');

      // --- Materials analytics. ---
      const materials = await request(app.getHttpServer())
        .get(`/projects/${project.id}/analytics/materials`)
        .query({ dateFrom: '2026-09-01', dateTo: '2026-10-01' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const row = materials.body.materials.find(
        (r: { materialId: string }) => r.materialId === material.id,
      );
      expect(row.purchasedQuantity).toBe('100.000000');
      expect(row.purchasedValueUzs).toBe('5000000.00');
      expect(row.consumedQuantity).toBe('30.000000');
      expect(row.consumedValueUzs).toBe('1500000.00000000');

      // --- Construction (block/floor) analytics. ---
      const construction = await request(app.getHttpServer())
        .get(`/projects/${project.id}/analytics/construction`)
        .query({ dateFrom: '2026-09-01', dateTo: '2026-10-01' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(construction.body.rows).toHaveLength(1);
      expect(construction.body.rows[0]).toMatchObject({
        blockId: block.id,
        floorId: floor.id,
        materialId: material.id,
        quantity: '30.000000',
        valueUzs: '1500000.00000000',
      });
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });

  describe('Authorization and isolation', () => {
    it('OWNER/ACCOUNTANT can read any active project; a manager of a different project cannot', async () => {
      const { project } = await setupProjectAndManager();
      const other = await setupProjectAndManager();
      const owner = await createTestUser(prisma.client, { role: Role.OWNER });
      try {
        const ownerToken = await loginTestUser(
          app.getHttpServer(),
          owner.email,
        );
        await request(app.getHttpServer())
          .get(`/projects/${project.id}/analytics/summary`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .expect(200);
        await request(app.getHttpServer())
          .get(`/projects/${project.id}/analytics/summary`)
          .set('Authorization', `Bearer ${other.token}`)
          .expect(403);
      } finally {
        await deleteTestUser(prisma.client, owner.id);
        await deleteTestProject(prisma.client, project.id);
        await deleteTestProject(prisma.client, other.project.id);
      }
    });
  });

  describe('Empty project', () => {
    it('returns exact zeroes rather than erroring on a project with no activity', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const res = await request(app.getHttpServer())
          .get(`/projects/${project.id}/analytics/summary`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(res.body.cashUzs.current).toBe('0.00');
        expect(res.body.purchasesCount).toBe(0);
        expect(res.body.supplierDebtAsOf).toEqual([]);
        expect(res.body.currentInventoryValueUzs).toBe('0.00000000');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });
});
