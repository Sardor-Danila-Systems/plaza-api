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
  createTestSupplier,
  createTestUser,
  createTestWarehouse,
  deleteTestProject,
  loginTestUser,
} from './fixtures/auth.fixture.js';

/**
 * The two cash accounts (Наличные / Банковский счёт) and the CASHIER role
 * that runs them. Balances and every insufficient-cash check are per
 * account; a cashier reaches the cash ledger of their own project and
 * nothing else.
 */
describe('Cash accounts and the CASHIER role (e2e)', () => {
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

  const idem = () => randomUUID();

  async function setupProject() {
    const project = await createTestProject(
      prisma.client,
      `Cash Accounts ${randomUUID()}`,
    );
    const manager = await createTestUser(prisma.client, {
      role: Role.PROJECT_MANAGER,
      projectId: project.id,
    });
    const managerToken = await loginTestUser(
      app.getHttpServer(),
      manager.email,
    );
    return { project, managerToken };
  }

  async function addCashier(projectId: string) {
    const cashier = await createTestUser(prisma.client, {
      role: Role.CASHIER,
      projectId,
    });
    return loginTestUser(app.getHttpServer(), cashier.email);
  }

  function post(
    projectId: string,
    token: string,
    body: Record<string, unknown>,
  ) {
    return request(app.getHttpServer())
      .post(`/projects/${projectId}/finances`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idem())
      .send({ currency: 'UZS', occurredAt: '2026-10-01', ...body });
  }

  async function balance(projectId: string, token: string) {
    const res = await request(app.getHttpServer())
      .get(`/projects/${projectId}/finances/balance`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const byAccount = Object.fromEntries(
      (res.body.byAccount as { account: string; uzs: string }[]).map((a) => [
        a.account,
        a.uzs,
      ]),
    );
    return { total: res.body.uzs as string, ...byAccount };
  }

  describe('cash accounts', () => {
    it('keeps a separate balance per account, with the total as their sum', async () => {
      const { project, managerToken } = await setupProject();
      try {
        await post(project.id, managerToken, {
          type: 'INCOME',
          amount: '700000.00',
          account: 'CASH',
        }).expect(201);
        const bank = await post(project.id, managerToken, {
          type: 'INCOME',
          amount: '300000.00',
          account: 'BANK',
        }).expect(201);
        expect(bank.body.account).toBe('BANK');

        expect(await balance(project.id, managerToken)).toEqual({
          total: '1000000.00',
          CASH: '700000.00',
          BANK: '300000.00',
        });
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('defaults to physical cash when no account is named', async () => {
      const { project, managerToken } = await setupProject();
      try {
        const res = await post(project.id, managerToken, {
          type: 'INCOME',
          amount: '1000.00',
        }).expect(201);
        expect(res.body.account).toBe('CASH');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects spending from an account that is short even when the project total would cover it', async () => {
      const { project, managerToken } = await setupProject();
      try {
        await post(project.id, managerToken, {
          type: 'INCOME',
          amount: '500000.00',
          account: 'BANK',
        }).expect(201);

        const res = await post(project.id, managerToken, {
          type: 'EXPENSE',
          amount: '100000.00',
          account: 'CASH',
        }).expect(409);
        expect(res.body.code).toBe('INSUFFICIENT_CASH');

        await post(project.id, managerToken, {
          type: 'EXPENSE',
          amount: '100000.00',
          account: 'BANK',
        }).expect(201);
        expect(await balance(project.id, managerToken)).toMatchObject({
          BANK: '400000.00',
          CASH: '0.00',
        });
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('cancelling restores the account the money came from', async () => {
      const { project, managerToken } = await setupProject();
      try {
        await post(project.id, managerToken, {
          type: 'INCOME',
          amount: '200000.00',
          account: 'BANK',
        }).expect(201);
        const expense = await post(project.id, managerToken, {
          type: 'EXPENSE',
          amount: '50000.00',
          account: 'BANK',
        }).expect(201);

        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances/${expense.body.id}/cancel`)
          .set('Authorization', `Bearer ${managerToken}`)
          .set('Idempotency-Key', idem())
          .send({ reason: 'Ошибка' })
          .expect(200);

        expect(await balance(project.id, managerToken)).toMatchObject({
          BANK: '200000.00',
          CASH: '0.00',
        });
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it("refuses to cancel a purchase's cash payment from the cash ledger", async () => {
      const { project, managerToken } = await setupProject();
      try {
        await post(project.id, managerToken, {
          type: 'INCOME',
          amount: '1000000.00',
        }).expect(201);
        const supplier = await createTestSupplier(prisma.client, project.id);
        const warehouse = await createTestWarehouse(prisma.client, project.id);
        const category = await prisma.client.materialCategory.create({
          data: { projectId: project.id, name: `Cat ${randomUUID()}` },
        });
        const unit = await prisma.client.unit.create({
          data: { projectId: project.id, name: 'Piece', symbol: 'pc' },
        });
        const material = await prisma.client.material.create({
          data: {
            projectId: project.id,
            name: 'Brick',
            code: `m-${randomUUID()}`,
            categoryId: category.id,
            unitId: unit.id,
          },
        });
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/purchases`)
          .set('Authorization', `Bearer ${managerToken}`)
          .set('Idempotency-Key', idem())
          .send({
            supplierId: supplier.id,
            warehouseId: warehouse.id,
            currency: 'UZS',
            items: [
              {
                materialId: material.id,
                quantity: '1.000000',
                unitPrice: '100000.00000000',
              },
            ],
            cashPaid: '100000.00',
            occurredAt: '2026-10-01',
          })
          .expect(201);

        const ledger = await request(app.getHttpServer())
          .get(`/projects/${project.id}/finances`)
          .query({ type: 'PURCHASE' })
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(200);
        const cashLeg = (ledger.body.data as { id: string }[])[0];

        const res = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances/${cashLeg.id}/cancel`)
          .set('Authorization', `Bearer ${managerToken}`)
          .set('Idempotency-Key', idem())
          .send({ reason: 'Попытка' })
          .expect(409);
        expect(res.body.code).toBe('CANCEL_VIA_SOURCE_OPERATION');
        // Nothing moved: the payment still stands.
        expect(await balance(project.id, managerToken)).toMatchObject({
          CASH: '900000.00',
        });
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('filters the ledger by account', async () => {
      const { project, managerToken } = await setupProject();
      try {
        await post(project.id, managerToken, {
          type: 'INCOME',
          amount: '1.00',
          account: 'CASH',
        }).expect(201);
        await post(project.id, managerToken, {
          type: 'INCOME',
          amount: '2.00',
          account: 'BANK',
        }).expect(201);

        const res = await request(app.getHttpServer())
          .get(`/projects/${project.id}/finances`)
          .query({ account: 'BANK' })
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(200);
        expect(
          (res.body.data as { amount: string }[]).map((t) => t.amount),
        ).toEqual(['2.00']);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it("a purchase's cash payment draws on the chosen account", async () => {
      const { project, managerToken } = await setupProject();
      try {
        await post(project.id, managerToken, {
          type: 'INCOME',
          amount: '1000000.00',
          account: 'BANK',
        }).expect(201);
        const supplier = await createTestSupplier(prisma.client, project.id);
        const warehouse = await createTestWarehouse(prisma.client, project.id);
        const category = await prisma.client.materialCategory.create({
          data: { projectId: project.id, name: `Cat ${randomUUID()}` },
        });
        const unit = await prisma.client.unit.create({
          data: { projectId: project.id, name: 'Piece', symbol: 'pc' },
        });
        const material = await prisma.client.material.create({
          data: {
            projectId: project.id,
            name: 'Cement',
            code: `m-${randomUUID()}`,
            categoryId: category.id,
            unitId: unit.id,
          },
        });

        await request(app.getHttpServer())
          .post(`/projects/${project.id}/purchases`)
          .set('Authorization', `Bearer ${managerToken}`)
          .set('Idempotency-Key', idem())
          .send({
            supplierId: supplier.id,
            warehouseId: warehouse.id,
            currency: 'UZS',
            account: 'BANK',
            items: [
              {
                materialId: material.id,
                quantity: '10.000000',
                unitPrice: '30000.00000000',
              },
            ],
            cashPaid: '300000.00',
            occurredAt: '2026-10-01',
          })
          .expect(201);

        expect(await balance(project.id, managerToken)).toMatchObject({
          BANK: '700000.00',
          CASH: '0.00',
        });
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });

  describe('CASHIER role', () => {
    it('posts, reads and cancels in the cash ledger of their own project', async () => {
      const { project } = await setupProject();
      try {
        const token = await addCashier(project.id);

        const income = await post(project.id, token, {
          type: 'INCOME',
          amount: '100000.00',
          account: 'CASH',
        }).expect(201);
        await post(project.id, token, {
          type: 'SALARY',
          amount: '40000.00',
          account: 'CASH',
          recipient: 'Рабочий',
        }).expect(201);

        await request(app.getHttpServer())
          .get(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        await request(app.getHttpServer())
          .get(`/projects/${project.id}/finances/${income.body.id}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(await balance(project.id, token)).toMatchObject({
          CASH: '60000.00',
        });

        // Their own project's name is readable — every screen shows it.
        await request(app.getHttpServer())
          .get(`/projects/${project.id}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        const projects = await request(app.getHttpServer())
          .get('/projects')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect((projects.body as { id: string }[]).map((p) => p.id)).toEqual(
          [project.id],
        );

        // Transaction categories belong to the cash ledger too.
        await request(app.getHttpServer())
          .get(`/projects/${project.id}/transaction-categories`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('is denied everything outside the cash ledger', async () => {
      const { project } = await setupProject();
      try {
        const token = await addCashier(project.id);
        const supplier = await createTestSupplier(prisma.client, project.id);

        for (const path of [
          'suppliers',
          `suppliers/${supplier.id}`,
          `suppliers/${supplier.id}/ledger`,
          `suppliers/${supplier.id}/advances`,
          'purchases',
          'warehouses',
          'materials',
          'material-categories',
          'units',
          'inventory',
          'inventory/write-offs',
          'construction/blocks',
          'analytics/summary',
          'audit',
          'attachments',
        ]) {
          const res = await request(app.getHttpServer())
            .get(`/projects/${project.id}/${path}`)
            .set('Authorization', `Bearer ${token}`);
          expect({ path, status: res.status }).toEqual({ path, status: 403 });
        }

        await request(app.getHttpServer())
          .post(`/projects/${project.id}/suppliers`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Не положено' })
          .expect(403);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it("cannot reach another project's cash ledger", async () => {
      const own = await setupProject();
      const other = await setupProject();
      try {
        const token = await addCashier(own.project.id);
        await request(app.getHttpServer())
          .get(`/projects/${other.project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .expect(403);
        await post(other.project.id, token, {
          type: 'INCOME',
          amount: '1.00',
        }).expect(403);
      } finally {
        await deleteTestProject(prisma.client, own.project.id);
        await deleteTestProject(prisma.client, other.project.id);
      }
    });

    it('a project can have several cashiers alongside its one manager', async () => {
      const { project } = await setupProject();
      try {
        const first = await addCashier(project.id);
        const second = await addCashier(project.id);
        await post(project.id, first, {
          type: 'INCOME',
          amount: '10.00',
        }).expect(201);
        await post(project.id, second, {
          type: 'INCOME',
          amount: '20.00',
        }).expect(201);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('the database refuses a cashier without a project', async () => {
      await expect(
        createTestUser(prisma.client, { role: Role.CASHIER }),
      ).rejects.toThrow();
    });
  });
});
