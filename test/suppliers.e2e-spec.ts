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
  deleteTestUser,
  loginTestUser,
} from './fixtures/auth.fixture.js';

describe('Suppliers, advances, and debt payments (e2e)', () => {
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
      `Supplier Test ${randomUUID()}`,
    );
    const manager = await createTestUser(prisma.client, {
      role: Role.PROJECT_MANAGER,
      projectId: project.id,
    });
    const token = await loginTestUser(app.getHttpServer(), manager.email);
    return { project, manager, token };
  }

  function idem(): string {
    return randomUUID();
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
  // Supplier CRUD
  // -----------------------------------------------------------------
  describe('Supplier CRUD', () => {
    it('PROJECT_MANAGER can create, list, read, and archive a supplier', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const created = await request(app.getHttpServer())
          .post(`/projects/${project.id}/suppliers`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'ACME Supplies', phone: '+998901234567' })
          .expect(201);

        const list = await request(app.getHttpServer())
          .get(`/projects/${project.id}/suppliers`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(list.body).toHaveLength(1);

        const archived = await request(app.getHttpServer())
          .patch(`/projects/${project.id}/suppliers/${created.body.id}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ isActive: false })
          .expect(200);
        expect(archived.body.isActive).toBe(false);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('OWNER/ACCOUNTANT can read but not create suppliers', async () => {
      const project = await createTestProject(
        prisma.client,
        `Owner Supplier Test ${randomUUID()}`,
      );
      const owner = await createTestUser(prisma.client, { role: Role.OWNER });
      try {
        const token = await loginTestUser(app.getHttpServer(), owner.email);
        await request(app.getHttpServer())
          .get(`/projects/${project.id}/suppliers`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/suppliers`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'X' })
          .expect(403);
      } finally {
        await deleteTestUser(prisma.client, owner.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('stores a nine-digit taxpayer id and rejects any other shape', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const created = await request(app.getHttpServer())
          .post(`/projects/${project.id}/suppliers`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'ACME Supplies', taxId: '012345678' })
          .expect(201);
        // Leading zero survives — it is an identifier, not a number.
        expect(created.body.taxId).toBe('012345678');

        const read = await request(app.getHttpServer())
          .get(`/projects/${project.id}/suppliers/${created.body.id}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(read.body.taxId).toBe('012345678');

        const updated = await request(app.getHttpServer())
          .patch(`/projects/${project.id}/suppliers/${created.body.id}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ taxId: '987654321' })
          .expect(200);
        expect(updated.body.taxId).toBe('987654321');

        for (const taxId of ['12345678', '1234567890', '12345678a', '']) {
          await request(app.getHttpServer())
            .post(`/projects/${project.id}/suppliers`)
            .set('Authorization', `Bearer ${token}`)
            .send({ name: 'Bad Tax Id', taxId })
            .expect(400);
        }

        // Omitting it entirely stays valid — the field is optional.
        const without = await request(app.getHttpServer())
          .post(`/projects/${project.id}/suppliers`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'No Tax Id' })
          .expect(201);
        expect(without.body.taxId).toBeNull();
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('PATCH null clears an optional field; omitting the key leaves it untouched; empty string is still rejected', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const created = await request(app.getHttpServer())
          .post(`/projects/${project.id}/suppliers`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            name: 'Clearable Supplies',
            contactPerson: 'Alisher',
            phone: '+998901112233',
            taxId: '123456789',
            comment: 'some note',
          })
          .expect(201);

        // Omitting a key entirely: every other field stays exactly as it
        // was (this is what distinguishes "not provided" from "clear").
        const untouched = await request(app.getHttpServer())
          .patch(`/projects/${project.id}/suppliers/${created.body.id}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ comment: 'updated note' })
          .expect(200);
        expect(untouched.body.contactPerson).toBe('Alisher');
        expect(untouched.body.phone).toBe('+998901112233');
        expect(untouched.body.taxId).toBe('123456789');
        expect(untouched.body.comment).toBe('updated note');

        // Explicit null clears each field.
        const cleared = await request(app.getHttpServer())
          .patch(`/projects/${project.id}/suppliers/${created.body.id}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ contactPerson: null, phone: null, taxId: null, comment: null })
          .expect(200);
        expect(cleared.body.contactPerson).toBeNull();
        expect(cleared.body.phone).toBeNull();
        expect(cleared.body.taxId).toBeNull();
        expect(cleared.body.comment).toBeNull();

        // Empty string is not the same as null — still a validation error,
        // never a silent clear via the wrong value.
        await request(app.getHttpServer())
          .patch(`/projects/${project.id}/suppliers/${created.body.id}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ taxId: '' })
          .expect(400);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('searches suppliers by name, contact person, phone and taxpayer id', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const create = (body: Record<string, unknown>) =>
          request(app.getHttpServer())
            .post(`/projects/${project.id}/suppliers`)
            .set('Authorization', `Bearer ${token}`)
            .send(body)
            .expect(201);

        await create({
          name: 'Бетон Завод',
          contactPerson: 'Алишер',
          phone: '+998901112233',
          taxId: '123456789',
        });
        await create({
          name: 'Кирпич Плюс',
          contactPerson: 'Дилшод',
          phone: '+998907778899',
          taxId: '987654321',
        });

        const search = async (term: string) => {
          const res = await request(app.getHttpServer())
            .get(`/projects/${project.id}/suppliers`)
            .query({ search: term })
            .set('Authorization', `Bearer ${token}`)
            .expect(200);
          return (res.body as { name: string }[]).map((s) => s.name);
        };

        expect(await search('бетон')).toEqual(['Бетон Завод']);
        expect(await search('Алишер')).toEqual(['Бетон Завод']);
        expect(await search('7778899')).toEqual(['Кирпич Плюс']);
        expect(await search('987654321')).toEqual(['Кирпич Плюс']);
        expect(await search('нет такого')).toEqual([]);
        // No search term still returns everything.
        const all = await request(app.getHttpServer())
          .get(`/projects/${project.id}/suppliers`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(all.body).toHaveLength(2);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('filters suppliers by active state', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const kept = await request(app.getHttpServer())
          .post(`/projects/${project.id}/suppliers`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Активный' })
          .expect(201);
        const archived = await request(app.getHttpServer())
          .post(`/projects/${project.id}/suppliers`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Архивный' })
          .expect(201);
        await request(app.getHttpServer())
          .patch(`/projects/${project.id}/suppliers/${archived.body.id}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ isActive: false })
          .expect(200);

        const active = await request(app.getHttpServer())
          .get(`/projects/${project.id}/suppliers`)
          .query({ isActive: 'true' })
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect((active.body as { id: string }[]).map((s) => s.id)).toEqual([
          kept.body.id,
        ]);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it("a manager of a different project cannot access this project's suppliers", async () => {
      const { project } = await setupProjectAndManager();
      const other = await setupProjectAndManager();
      try {
        const supplier = await createTestSupplier(prisma.client, project.id);
        await request(app.getHttpServer())
          .get(`/projects/${project.id}/suppliers/${supplier.id}`)
          .set('Authorization', `Bearer ${other.token}`)
          .expect(403);
      } finally {
        await deleteTestProject(prisma.client, project.id);
        await deleteTestProject(prisma.client, other.project.id);
      }
    });
  });

  // -----------------------------------------------------------------
  // Supplier advances
  // -----------------------------------------------------------------
  describe('POST /suppliers/:id/advances', () => {
    it('funds an advance: cash decreases, advance available balance increases', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        await fundCash(project.id, token, '50000000.00');
        const supplier = await createTestSupplier(prisma.client, project.id);

        const advance = await request(app.getHttpServer())
          .post(`/projects/${project.id}/suppliers/${supplier.id}/advances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            currency: 'UZS',
            amount: '10000000.00',
            occurredAt: '2026-09-14',
          })
          .expect(201);
        expect(advance.body.fundedAmount).toBe('10000000.00');
        expect(advance.body.availableAmount).toBe('10000000.00');

        const balance = await request(app.getHttpServer())
          .get(`/projects/${project.id}/finances/balance`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(balance.body.uzs).toBe('40000000.00');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects funding an advance beyond available cash', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const supplier = await createTestSupplier(prisma.client, project.id);
        const response = await request(app.getHttpServer())
          .post(`/projects/${project.id}/suppliers/${supplier.id}/advances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            currency: 'UZS',
            amount: '1000.00',
            occurredAt: '2026-09-14',
          })
          .expect(409);
        expect(response.body.code).toBe('INSUFFICIENT_CASH');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('replays an identical retried advance request', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        await fundCash(project.id, token, '50000000.00');
        const supplier = await createTestSupplier(prisma.client, project.id);
        const key = idem();
        const payload = {
          currency: 'UZS',
          amount: '10000000.00',
          occurredAt: '2026-09-14',
        };

        const first = await request(app.getHttpServer())
          .post(`/projects/${project.id}/suppliers/${supplier.id}/advances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', key)
          .send(payload)
          .expect(201);
        const second = await request(app.getHttpServer())
          .post(`/projects/${project.id}/suppliers/${supplier.id}/advances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', key)
          .send(payload)
          .expect(200);
        expect(second.body.id).toBe(first.body.id);

        const count = await prisma.client.supplierAdvance.count({
          where: { supplierId: supplier.id },
        });
        expect(count).toBe(1);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });

  // -----------------------------------------------------------------
  // Debt payments (cross-currency settlement)
  // -----------------------------------------------------------------
  describe('POST /suppliers/:id/debt-payments', () => {
    it('case 1: same-currency settlement (UZS debt paid in UZS)', async () => {
      const { project, manager, token } = await setupProjectAndManager();
      try {
        await fundCash(project.id, token, '50000000.00');
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
            totalAmount: '30000000.00',
          },
        );

        const payment = await request(app.getHttpServer())
          .post(
            `/projects/${project.id}/suppliers/${supplier.id}/debt-payments`,
          )
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            purchaseId: purchase.id,
            currency: 'UZS',
            amount: '10000000.00',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        expect(payment.body.debtAmountSettled).toBe('10000000.00');
        expect(payment.body.exchangeDifferenceUzs).toBe('0.00');

        const ledger = await request(app.getHttpServer())
          .get(`/projects/${project.id}/suppliers/${supplier.id}/ledger`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        const uzsDebt = ledger.body.outstandingDebt.find(
          (d: { currency: string }) => d.currency === 'UZS',
        );
        expect(uzsDebt.amount).toBe('20000000.00');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('case 3: cross-currency settlement (USD debt paid with UZS cash), requires an explicit rate', async () => {
      const { project, manager, token } = await setupProjectAndManager();
      try {
        await fundCash(project.id, token, '50000000.00');
        const supplier = await createTestSupplier(prisma.client, project.id);
        const warehouse = await createTestWarehouse(prisma.client, project.id);
        const purchase = await createTestPurchase(
          prisma.client,
          project.id,
          supplier.id,
          warehouse.id,
          manager.id,
          {
            currency: 'USD',
            exchangeRate: '12500.00000000',
            totalAmount: '1000.00',
            totalAmountUzs: '12500000.00',
          },
        );

        // Missing settlementExchangeRate -> rejected
        const missingRate = await request(app.getHttpServer())
          .post(
            `/projects/${project.id}/suppliers/${supplier.id}/debt-payments`,
          )
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            purchaseId: purchase.id,
            currency: 'UZS',
            amount: '12500000.00',
            occurredAt: '2026-09-14',
          })
          .expect(409);
        expect(missingRate.body.code).toBe('SETTLEMENT_RATE_REQUIRED');

        // With explicit rate -> succeeds, matching the doc's worked example
        // exactly: USD 1,000 debt paid with UZS 12,500,000 at 12,500 UZS/USD.
        const payment = await request(app.getHttpServer())
          .post(
            `/projects/${project.id}/suppliers/${supplier.id}/debt-payments`,
          )
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            purchaseId: purchase.id,
            currency: 'UZS',
            amount: '12500000.00',
            settlementExchangeRate: '12500.00000000',
            occurredAt: '2026-09-14',
          })
          .expect(201);
        expect(payment.body.debtAmountSettled).toBe('1000.00');
        expect(payment.body.settlementCurrency).toBe('UZS');
        expect(payment.body.debtCurrency).toBe('USD');

        const ledger = await request(app.getHttpServer())
          .get(`/projects/${project.id}/suppliers/${supplier.id}/ledger`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(ledger.body.outstandingDebt).toHaveLength(0);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects a debt payment exceeding the remaining debt', async () => {
      const { project, manager, token } = await setupProjectAndManager();
      try {
        await fundCash(project.id, token, '50000000.00');
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

        const response = await request(app.getHttpServer())
          .post(
            `/projects/${project.id}/suppliers/${supplier.id}/debt-payments`,
          )
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            purchaseId: purchase.id,
            currency: 'UZS',
            amount: '20000000.00',
            occurredAt: '2026-09-14',
          })
          .expect(409);
        expect(response.body.code).toBe('DEBT_PAYMENT_EXCEEDS_REMAINING');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('supports partial debt payment, preserving allocation history', async () => {
      const { project, manager, token } = await setupProjectAndManager();
      try {
        await fundCash(project.id, token, '50000000.00');
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
            totalAmount: '30000000.00',
          },
        );

        await request(app.getHttpServer())
          .post(
            `/projects/${project.id}/suppliers/${supplier.id}/debt-payments`,
          )
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            purchaseId: purchase.id,
            currency: 'UZS',
            amount: '10000000.00',
            occurredAt: '2026-09-14',
          })
          .expect(201);
        await request(app.getHttpServer())
          .post(
            `/projects/${project.id}/suppliers/${supplier.id}/debt-payments`,
          )
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            purchaseId: purchase.id,
            currency: 'UZS',
            amount: '15000000.00',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        const allocationsCount = await prisma.client.settlementAllocation.count(
          {
            where: { purchaseId: purchase.id },
          },
        );
        expect(allocationsCount).toBe(2);

        const ledger = await request(app.getHttpServer())
          .get(`/projects/${project.id}/suppliers/${supplier.id}/ledger`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(ledger.body.outstandingDebt[0].amount).toBe('5000000.00');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects paying a cancelled purchase', async () => {
      const { project, manager, token } = await setupProjectAndManager();
      try {
        await fundCash(project.id, token, '50000000.00');
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
        await prisma.client.purchase.update({
          where: { id: purchase.id },
          data: {
            cancelledAt: new Date(),
            cancellationReason: 'test',
            cancelledById: manager.id,
          },
        });

        const response = await request(app.getHttpServer())
          .post(
            `/projects/${project.id}/suppliers/${supplier.id}/debt-payments`,
          )
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            purchaseId: purchase.id,
            currency: 'UZS',
            amount: '1000000.00',
            occurredAt: '2026-09-14',
          })
          .expect(409);
        expect(response.body.code).toBe('PURCHASE_ALREADY_CANCELLED');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });
});
