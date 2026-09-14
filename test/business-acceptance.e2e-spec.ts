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
  createTestUnit,
  createTestUser,
  createTestWarehouse,
  deleteTestProject,
  deleteTestUser,
  loginTestUser,
} from './fixtures/auth.fixture.js';

// A standard 1x1 transparent PNG — real magic bytes.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

/**
 * Phase 12/13 — the final, complete Euro Plaza business acceptance
 * scenario, end to end, against real PostgreSQL: everything a real
 * PROJECT_MANAGER would do in one project's lifecycle, cross-checked
 * against exact expected values at each step, followed by OWNER/ACCOUNTANT
 * read-only verification.
 */
describe('Business acceptance scenario (e2e)', () => {
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

  it('runs the full lifecycle for a PROJECT_MANAGER, then verifies OWNER/ACCOUNTANT read-only access', async () => {
    // 1. Provision project + manager (the CLI/seed-equivalent step).
    const project = await createTestProject(
      prisma.client,
      `Acceptance ${randomUUID()}`,
    );
    const manager = await createTestUser(prisma.client, {
      role: Role.PROJECT_MANAGER,
      projectId: project.id,
    });
    const owner = await createTestUser(prisma.client, { role: Role.OWNER });
    const accountant = await createTestUser(prisma.client, {
      role: Role.ACCOUNTANT,
    });

    try {
      // 2. Login as PROJECT_MANAGER.
      const token = await loginTestUser(app.getHttpServer(), manager.email);

      // 3. Create income (project's opening cash).
      await request(app.getHttpServer())
        .post(`/projects/${project.id}/finances`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idem())
        .send({
          type: 'INCOME',
          amount: '50000000.00',
          currency: 'UZS',
          source: 'Owner capital',
          occurredAt: '2026-09-01',
        })
        .expect(201);

      // 4. Create supplier.
      const supplierRes = await request(app.getHttpServer())
        .post(`/projects/${project.id}/suppliers`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Acceptance Supplier', phone: '+998901112233' })
        .expect(201);
      const supplierId = supplierRes.body.id as string;

      // 5. Create supplier advance (20,000,000).
      const advanceRes = await request(app.getHttpServer())
        .post(`/projects/${project.id}/suppliers/${supplierId}/advances`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idem())
        .send({
          currency: 'UZS',
          amount: '20000000.00',
          occurredAt: '2026-09-02',
        })
        .expect(201);
      const advanceId = advanceRes.body.id as string;

      // 6. Warehouse/material setup.
      const category = await createTestMaterialCategory(
        prisma.client,
        project.id,
      );
      const unit = await createTestUnit(prisma.client, project.id);
      const warehouseA = await createTestWarehouse(prisma.client, project.id, {
        name: 'Main Warehouse',
      });
      const warehouseB = await createTestWarehouse(prisma.client, project.id, {
        name: 'Site Warehouse',
      });
      const material = await createTestMaterial(
        prisma.client,
        project.id,
        category.id,
        unit.id,
        { name: 'Cement' },
      );
      const block = await createTestBlock(prisma.client, project.id, {
        name: 'Block A',
      });
      const floor = await createTestFloor(prisma.client, project.id, block.id, {
        label: 'Floor 1',
      });

      // 7. Purchase funded by advance (20,000,000) + cash (10,000,000) + debt
      // (remaining). 300 units @ 100,000 = 30,000,000 total.
      const purchaseRes = await request(app.getHttpServer())
        .post(`/projects/${project.id}/purchases`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idem())
        .send({
          supplierId,
          warehouseId: warehouseA.id,
          currency: 'UZS',
          items: [
            {
              materialId: material.id,
              quantity: '300.000000',
              unitPrice: '100000.00000000',
            },
          ],
          advanceAllocations: [{ advanceId, amount: '20000000.00' }],
          cashPaid: '5000000.00',
          occurredAt: '2026-09-03',
        })
        .expect(201);
      expect(purchaseRes.body.totalAmount).toBe('30000000.00');
      // 30m - 20m (advance) - 5m (cash) = 5m remaining debt.
      expect(purchaseRes.body.remainingDebt).toBe('5000000.00');
      expect(purchaseRes.body.status).toBe('PARTIALLY_PAID');
      const purchaseId = purchaseRes.body.id as string;

      // 8. Verify stock: 300 units @ 100,000 = 30,000,000 value.
      const balanceAfterPurchase =
        await prisma.client.inventoryBalance.findUniqueOrThrow({
          where: {
            warehouseId_materialId: {
              warehouseId: warehouseA.id,
              materialId: material.id,
            },
          },
        });
      expect(balanceAfterPurchase.quantity.toFixed(6)).toBe('300.000000');
      expect(balanceAfterPurchase.valueUzs.toFixed(8)).toBe(
        '30000000.00000000',
      );

      // 9. Transfer 100 units to the site warehouse.
      await request(app.getHttpServer())
        .post(`/projects/${project.id}/inventory/transfers`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idem())
        .send({
          sourceWarehouseId: warehouseA.id,
          destinationWarehouseId: warehouseB.id,
          materialId: material.id,
          quantity: '100.000000',
          occurredAt: '2026-09-04',
        })
        .expect(201);

      // 10. Write off 40 units to Block A / Floor 1 from the site warehouse.
      const writeOffRes = await request(app.getHttpServer())
        .post(`/projects/${project.id}/inventory/write-offs`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idem())
        .send({
          warehouseId: warehouseB.id,
          materialId: material.id,
          blockId: block.id,
          floorId: floor.id,
          quantity: '40.000000',
          occurredAt: '2026-09-05',
        })
        .expect(201);
      expect(writeOffRes.body.totalCostUzs).toBe('4000000.00000000'); // 40 * 100,000

      // 11. Pay down the remaining 5,000,000 debt.
      await request(app.getHttpServer())
        .post(`/projects/${project.id}/suppliers/${supplierId}/debt-payments`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idem())
        .send({
          purchaseId,
          currency: 'UZS',
          amount: '5000000.00',
          occurredAt: '2026-09-06',
        })
        .expect(201);

      // 12. Verify exact finance/debt/advance/inventory values.
      const balance = await request(app.getHttpServer())
        .get(`/projects/${project.id}/finances/balance`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      // 50m income - 20m advance funding - 5m purchase cash - 5m debt payment = 20m.
      expect(balance.body.uzs).toBe('20000000.00');

      const purchaseAfterDebtPayment = await request(app.getHttpServer())
        .get(`/projects/${project.id}/purchases/${purchaseId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(purchaseAfterDebtPayment.body.remainingDebt).toBe('0.00');
      expect(purchaseAfterDebtPayment.body.status).toBe('PAID');

      const advanceConsumed =
        await prisma.client.settlementAllocation.aggregate({
          where: { advanceId, effect: 'APPLY' },
          _sum: { settlementAmount: true },
        });
      expect(advanceConsumed._sum.settlementAmount?.toFixed(2)).toBe(
        '20000000.00',
      );

      const sourceBalance =
        await prisma.client.inventoryBalance.findUniqueOrThrow({
          where: {
            warehouseId_materialId: {
              warehouseId: warehouseA.id,
              materialId: material.id,
            },
          },
        });
      expect(sourceBalance.quantity.toFixed(6)).toBe('200.000000'); // 300 - 100 transferred
      const destBalance =
        await prisma.client.inventoryBalance.findUniqueOrThrow({
          where: {
            warehouseId_materialId: {
              warehouseId: warehouseB.id,
              materialId: material.id,
            },
          },
        });
      expect(destBalance.quantity.toFixed(6)).toBe('60.000000'); // 100 transferred - 40 written off
      expect(destBalance.valueUzs.toFixed(8)).toBe('6000000.00000000'); // 60 * 100,000

      // 13. Inspect audit — the purchase creation must be recorded.
      const audit = await request(app.getHttpServer())
        .get(`/projects/${project.id}/audit`)
        .query({ entityType: 'Purchase', entityId: purchaseId })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(
        audit.body.data.some(
          (row: { action: string }) => row.action === 'purchase.create',
        ),
      ).toBe(true);

      // 14. Upload and retrieve an approved attachment, linked to the purchase.
      const attachment = await request(app.getHttpServer())
        .post(`/projects/${project.id}/attachments`)
        .set('Authorization', `Bearer ${token}`)
        .attach('file', PNG_BYTES, 'invoice-scan.png')
        .expect(201);
      await request(app.getHttpServer())
        .post(`/projects/${project.id}/attachments/${attachment.body.id}/link`)
        .set('Authorization', `Bearer ${token}`)
        .send({ target: 'PURCHASE', targetId: purchaseId })
        .expect(200);
      const download = await request(app.getHttpServer())
        .get(
          `/projects/${project.id}/attachments/${attachment.body.id}/download`,
        )
        .set('Authorization', `Bearer ${token}`)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(Buffer.compare(download.body as Buffer, PNG_BYTES)).toBe(0);

      // 15. Query analytics.
      const summary = await request(app.getHttpServer())
        .get(`/projects/${project.id}/analytics/summary`)
        .query({ dateFrom: '2026-09-01', dateTo: '2026-10-01' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(summary.body.cashUzs.current).toBe('20000000.00');
      expect(summary.body.supplierDebtAsOf).toEqual([
        { currency: 'UZS', amount: '0.00' },
      ]); // fully paid

      // 16. Export XLSX.
      const xlsxRes = await request(app.getHttpServer())
        .get(`/projects/${project.id}/reports/purchases.xlsx`)
        .set('Authorization', `Bearer ${token}`)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect((xlsxRes.body as Buffer).length).toBeGreaterThan(0);
      expect(xlsxRes.headers['content-type']).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );

      // 17-18. Attempt an unsafe purchase cancellation (a later transfer/
      // write-off/debt-payment already depends on this purchase's receipt
      // and settlement) — expect 409, verify the code.
      const unsafeCancel = await request(app.getHttpServer())
        .post(`/projects/${project.id}/purchases/${purchaseId}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idem())
        .send({ reason: 'attempt an unsafe cancellation' })
        .expect(409);
      expect(unsafeCancel.body.code).toBe('PURCHASE_HAS_DEPENDENT_MOVEMENTS');

      // 19. OWNER: read-only access.
      const ownerToken = await loginTestUser(app.getHttpServer(), owner.email);
      await request(app.getHttpServer())
        .get(`/projects/${project.id}/purchases/${purchaseId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/projects/${project.id}/analytics/summary`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      // 20. ACCOUNTANT: read/export-only access.
      const accountantToken = await loginTestUser(
        app.getHttpServer(),
        accountant.email,
      );
      await request(app.getHttpServer())
        .get(`/projects/${project.id}/reports/cash.xlsx`)
        .set('Authorization', `Bearer ${accountantToken}`)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);

      // 21. Verify mutation denial for both read-only roles.
      for (const roleToken of [ownerToken, accountantToken]) {
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${roleToken}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '1.00',
            currency: 'UZS',
            source: 'x',
            occurredAt: '2026-09-14',
          })
          .expect(403);
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/purchases`)
          .set('Authorization', `Bearer ${roleToken}`)
          .set('Idempotency-Key', idem())
          .send({
            supplierId,
            warehouseId: warehouseA.id,
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
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/inventory/write-offs`)
          .set('Authorization', `Bearer ${roleToken}`)
          .set('Idempotency-Key', idem())
          .send({
            warehouseId: warehouseA.id,
            materialId: material.id,
            blockId: block.id,
            floorId: floor.id,
            quantity: '1.000000',
            occurredAt: '2026-09-14',
          })
          .expect(403);
      }
    } finally {
      await deleteTestUser(prisma.client, owner.id);
      await deleteTestUser(prisma.client, accountant.id);
      await deleteTestProject(prisma.client, project.id);
    }
  }, 60000);
});
