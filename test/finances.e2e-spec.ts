import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  Role,
  TransactionCategoryKind,
} from '../src/generated/prisma/client.js';
import { setupApp } from '../src/setup-app.js';
import {
  createTestCategory,
  createTestCurrencyRate,
  createTestProject,
  createTestUser,
  deleteTestProject,
  deleteTestUser,
  loginTestUser,
} from './fixtures/auth.fixture.js';

/**
 * Phase 4's finance posting workflow, end to end, against real PostgreSQL
 * (docs/backend-architecture.md §12) — the project-lock/idempotency
 * infrastructure is real, not mocked, so these tests exercise the actual
 * transaction/CHECK-constraint/trigger stack, not a stand-in for it.
 */
describe('Finances (e2e)', () => {
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
      `Finance Test ${randomUUID()}`,
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

  describe('POST /projects/:projectId/finances', () => {
    it('creates a UZS income transaction', async () => {
      const { project, manager, token } = await setupProjectAndManager();
      try {
        const response = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '500000.00',
            currency: 'UZS',
            source: 'Owner capital contribution',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        expect(response.body.type).toBe('INCOME');
        expect(response.body.direction).toBe('IN');
        expect(response.body.amount).toBe('500000.00');
        expect(response.body.currency).toBe('UZS');
        expect(response.body.exchangeRate).toBe('1.00000000');
        expect(response.body.amountUzs).toBe('500000.00');
        expect(response.body.recipient).toBe('Owner capital contribution');
        expect(response.body.createdById).toBe(manager.id);
        expect(response.body.cancelledAt).toBeNull();
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('creates a UZS expense transaction after sufficient income exists', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '1000000.00',
            currency: 'UZS',
            source: 'Capital',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        const response = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'EXPENSE',
            amount: '300000.00',
            currency: 'UZS',
            recipient: 'ACME Building Supplies',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        expect(response.body.direction).toBe('OUT');
        expect(response.body.recipient).toBe('ACME Building Supplies');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('creates a SALARY transaction', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '1000000.00',
            currency: 'UZS',
            source: 'Capital',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        const response = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'SALARY',
            amount: '200000.00',
            currency: 'UZS',
            recipient: 'Site foreman',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        expect(response.body.type).toBe('SALARY');
        expect(response.body.direction).toBe('OUT');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('creates a USD income with an explicit exchangeRate override', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const response = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '100.00',
            currency: 'USD',
            exchangeRate: '12500.00000000',
            rateOverrideReason: 'Bank-quoted rate for this transfer',
            source: 'Foreign investor',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        expect(response.body.currency).toBe('USD');
        expect(response.body.exchangeRate).toBe('12500.00000000');
        expect(response.body.amountUzs).toBe('1250000.00');
        expect(response.body.rateId).toBeNull();
        expect(response.body.rateOverrideReason).toBe(
          'Bank-quoted rate for this transfer',
        );
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('creates a USD income referencing a recorded currencyRateId', async () => {
      const { project, manager, token } = await setupProjectAndManager();
      try {
        const rate = await createTestCurrencyRate(
          prisma.client,
          project.id,
          manager.id,
          {
            rateUzs: '12600.00000000',
          },
        );

        const response = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '100.00',
            currency: 'USD',
            currencyRateId: rate.id,
            source: 'Foreign investor',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        expect(response.body.exchangeRate).toBe('12600.00000000');
        expect(response.body.amountUzs).toBe('1260000.00');
        expect(response.body.rateId).toBe(rate.id);
        expect(response.body.rateOverrideReason).toBeNull();
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects a request with no Idempotency-Key header', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const response = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            type: 'INCOME',
            amount: '100.00',
            currency: 'UZS',
            occurredAt: '2026-09-14',
          })
          .expect(400);
        expect(response.body.code).toBe('VALIDATION_ERROR');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects a zero amount', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '0.00',
            currency: 'UZS',
            occurredAt: '2026-09-14',
          })
          .expect(400);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects a negative amount', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '-5.00',
            currency: 'UZS',
            occurredAt: '2026-09-14',
          })
          .expect(400);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects an amount with too many decimal places', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '100.999',
            currency: 'UZS',
            occurredAt: '2026-09-14',
          })
          .expect(400);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects exponent-notation amounts', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '1e5',
            currency: 'UZS',
            occurredAt: '2026-09-14',
          })
          .expect(400);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects a UZS transaction that supplies exchangeRate', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '100.00',
            currency: 'UZS',
            exchangeRate: '1.00000000',
            occurredAt: '2026-09-14',
          })
          .expect(400);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects a USD transaction with neither currencyRateId nor exchangeRate', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '100.00',
            currency: 'USD',
            occurredAt: '2026-09-14',
          })
          .expect(400);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects a USD transaction with both currencyRateId and exchangeRate', async () => {
      const { project, manager, token } = await setupProjectAndManager();
      try {
        const rate = await createTestCurrencyRate(
          prisma.client,
          project.id,
          manager.id,
        );
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '100.00',
            currency: 'USD',
            currencyRateId: rate.id,
            exchangeRate: '12000.00000000',
            rateOverrideReason: 'conflicting',
            occurredAt: '2026-09-14',
          })
          .expect(400);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects an INCOME transaction that supplies recipient instead of source', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '100.00',
            currency: 'UZS',
            recipient: 'wrong field',
            occurredAt: '2026-09-14',
          })
          .expect(400);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects an EXPENSE transaction that supplies source instead of recipient', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'EXPENSE',
            amount: '100.00',
            currency: 'UZS',
            source: 'wrong field',
            occurredAt: '2026-09-14',
          })
          .expect(400);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects a future business date', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const farFuture = new Date();
        farFuture.setFullYear(farFuture.getFullYear() + 1);
        const dateStr = farFuture.toISOString().slice(0, 10);
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '100.00',
            currency: 'UZS',
            occurredAt: dateStr,
          })
          .expect(400);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects a non-postable type (PURCHASE)', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'PURCHASE',
            amount: '100.00',
            currency: 'UZS',
            occurredAt: '2026-09-14',
          })
          .expect(400);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects EXPENSE beyond the current balance (INSUFFICIENT_CASH)', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const response = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'EXPENSE',
            amount: '100.00',
            currency: 'UZS',
            occurredAt: '2026-09-14',
          })
          .expect(409);
        expect(response.body.code).toBe('INSUFFICIENT_CASH');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects a categoryId belonging to a different project', async () => {
      const { project, token } = await setupProjectAndManager();
      const other = await createTestProject(
        prisma.client,
        `Other ${randomUUID()}`,
      );
      try {
        const category = await createTestCategory(prisma.client, other.id, {
          kind: TransactionCategoryKind.INCOME,
        });
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '100.00',
            currency: 'UZS',
            categoryId: category.id,
            occurredAt: '2026-09-14',
          })
          .expect(404);
      } finally {
        await deleteTestProject(prisma.client, project.id);
        await deleteTestProject(prisma.client, other.id);
      }
    });

    it('rejects a category kind mismatch (EXPENSE category on an INCOME transaction)', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const category = await createTestCategory(prisma.client, project.id, {
          kind: TransactionCategoryKind.EXPENSE,
        });
        const response = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '100.00',
            currency: 'UZS',
            categoryId: category.id,
            occurredAt: '2026-09-14',
          })
          .expect(400);
        expect(response.body.code).toBe('VALIDATION_ERROR');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects an archived category', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const category = await createTestCategory(prisma.client, project.id, {
          kind: TransactionCategoryKind.EXPENSE,
        });
        await prisma.client.transactionCategory.update({
          where: { id: category.id },
          data: { isActive: false },
        });
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'EXPENSE',
            amount: '1.00',
            currency: 'UZS',
            categoryId: category.id,
            occurredAt: '2026-09-14',
          })
          .expect(400);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('OWNER cannot post a financial transaction', async () => {
      const project = await createTestProject(
        prisma.client,
        `Owner Test ${randomUUID()}`,
      );
      const owner = await createTestUser(prisma.client, { role: Role.OWNER });
      try {
        const token = await loginTestUser(app.getHttpServer(), owner.email);
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '1.00',
            currency: 'UZS',
            occurredAt: '2026-09-14',
          })
          .expect(403);
      } finally {
        await deleteTestUser(prisma.client, owner.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('ACCOUNTANT cannot post a financial transaction', async () => {
      const project = await createTestProject(
        prisma.client,
        `Accountant Test ${randomUUID()}`,
      );
      const accountant = await createTestUser(prisma.client, {
        role: Role.ACCOUNTANT,
      });
      try {
        const token = await loginTestUser(
          app.getHttpServer(),
          accountant.email,
        );
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '1.00',
            currency: 'UZS',
            occurredAt: '2026-09-14',
          })
          .expect(403);
      } finally {
        await deleteTestUser(prisma.client, accountant.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('a manager of a different project cannot post here', async () => {
      const { project } = await setupProjectAndManager();
      const other = await createTestProject(
        prisma.client,
        `Other Manager ${randomUUID()}`,
      );
      const otherManager = await createTestUser(prisma.client, {
        role: Role.PROJECT_MANAGER,
        projectId: other.id,
      });
      try {
        const token = await loginTestUser(
          app.getHttpServer(),
          otherManager.email,
        );
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '1.00',
            currency: 'UZS',
            occurredAt: '2026-09-14',
          })
          .expect(403);
      } finally {
        await deleteTestProject(prisma.client, project.id);
        await deleteTestProject(prisma.client, other.id);
      }
    });

    it('replays an identical retried request (same key, same payload) with 200 and the same id', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const key = idem();
        const payload = {
          type: 'INCOME',
          amount: '100.00',
          currency: 'UZS',
          source: 'x',
          occurredAt: '2026-09-14',
        };

        const first = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', key)
          .send(payload)
          .expect(201);

        const second = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', key)
          .send(payload)
          .expect(200);

        expect(second.body.id).toBe(first.body.id);

        const count = await prisma.client.financialTransaction.count({
          where: { projectId: project.id },
        });
        expect(count).toBe(1);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects a retried request with the same key but a different payload', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const key = idem();
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', key)
          .send({
            type: 'INCOME',
            amount: '100.00',
            currency: 'UZS',
            source: 'x',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        const response = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', key)
          .send({
            type: 'INCOME',
            amount: '200.00',
            currency: 'UZS',
            source: 'x',
            occurredAt: '2026-09-14',
          })
          .expect(409);
        expect(response.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });

  describe('GET /projects/:projectId/finances', () => {
    it('lists, paginates, and filters transactions', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        for (let i = 0; i < 3; i += 1) {
          await request(app.getHttpServer())
            .post(`/projects/${project.id}/finances`)
            .set('Authorization', `Bearer ${token}`)
            .set('Idempotency-Key', idem())
            .send({
              type: 'INCOME',
              amount: '100.00',
              currency: 'UZS',
              source: 'x',
              occurredAt: '2026-09-14',
            })
            .expect(201);
        }
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'EXPENSE',
            amount: '50.00',
            currency: 'UZS',
            recipient: 'x',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        const all = await request(app.getHttpServer())
          .get(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(all.body.total).toBe(4);
        expect(all.body.data).toHaveLength(4);

        const page1 = await request(app.getHttpServer())
          .get(`/projects/${project.id}/finances?page=1&pageSize=2`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(page1.body.data).toHaveLength(2);
        expect(page1.body.total).toBe(4);

        const incomeOnly = await request(app.getHttpServer())
          .get(`/projects/${project.id}/finances?type=INCOME`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(incomeOnly.body.total).toBe(3);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('excludes cancelled transactions by default and includes them with includeCancelled=true', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const created = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '100.00',
            currency: 'UZS',
            source: 'x',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances/${created.body.id}/cancel`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({ reason: 'mistake' })
          .expect(200);

        const excludingCancelled = await request(app.getHttpServer())
          .get(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(excludingCancelled.body.total).toBe(1); // only the reversal row remains uncancelled

        const includingCancelled = await request(app.getHttpServer())
          .get(`/projects/${project.id}/finances?includeCancelled=true`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(includingCancelled.body.total).toBe(2);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });

  describe('GET /projects/:projectId/finances/:id', () => {
    it('returns 404 for a transaction from a different project', async () => {
      const { project, token } = await setupProjectAndManager();
      const other = await setupProjectAndManager();
      try {
        const created = await request(app.getHttpServer())
          .post(`/projects/${other.project.id}/finances`)
          .set('Authorization', `Bearer ${other.token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '1.00',
            currency: 'UZS',
            source: 'x',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        await request(app.getHttpServer())
          .get(`/projects/${project.id}/finances/${created.body.id}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(404);
      } finally {
        await deleteTestProject(prisma.client, project.id);
        await deleteTestProject(prisma.client, other.project.id);
      }
    });
  });

  describe('GET /projects/:projectId/finances/balance', () => {
    it('computes independent nominal balances per currency', async () => {
      const { project, manager, token } = await setupProjectAndManager();
      try {
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '1000000.00',
            currency: 'UZS',
            source: 'x',
            occurredAt: '2026-09-14',
          })
          .expect(201);
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'EXPENSE',
            amount: '300000.00',
            currency: 'UZS',
            recipient: 'x',
            occurredAt: '2026-09-14',
          })
          .expect(201);
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '200.00',
            currency: 'USD',
            exchangeRate: '12500.00000000',
            rateOverrideReason: 'x',
            source: 'x',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        const balance = await request(app.getHttpServer())
          .get(`/projects/${project.id}/finances/balance`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(balance.body.uzs).toBe('700000.00');
        expect(balance.body.usd).toBe('200.00');
        void manager;
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });

  describe('PATCH /projects/:projectId/finances/:id (comment)', () => {
    it('edits only the comment field', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const created = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '100.00',
            currency: 'UZS',
            source: 'x',
            comment: 'original',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        const updated = await request(app.getHttpServer())
          .patch(`/projects/${project.id}/finances/${created.body.id}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ comment: 'corrected' })
          .expect(200);

        expect(updated.body.comment).toBe('corrected');
        expect(updated.body.amount).toBe(created.body.amount);
        expect(updated.body.amountUzs).toBe(created.body.amountUzs);
        expect(updated.body.type).toBe(created.body.type);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('still allows a comment edit after cancellation', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const created = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '100.00',
            currency: 'UZS',
            source: 'x',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances/${created.body.id}/cancel`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({ reason: 'mistake' })
          .expect(200);

        const updated = await request(app.getHttpServer())
          .patch(`/projects/${project.id}/finances/${created.body.id}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ comment: 'noted after cancellation' })
          .expect(200);
        expect(updated.body.comment).toBe('noted after cancellation');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });

  describe('POST /projects/:projectId/finances/:id/cancel', () => {
    it('creates an exact inverse and marks the original cancelled', async () => {
      const { project, manager, token } = await setupProjectAndManager();
      try {
        const created = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '100.00',
            currency: 'UZS',
            source: 'x',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        const cancelled = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances/${created.body.id}/cancel`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({ reason: 'duplicate entry' })
          .expect(200);

        expect(cancelled.body.id).toBe(created.body.id);
        expect(cancelled.body.cancelledAt).not.toBeNull();
        expect(cancelled.body.cancellationReason).toBe('duplicate entry');
        expect(cancelled.body.cancelledById).toBe(manager.id);
        // Original's own fields remain unchanged.
        expect(cancelled.body.amount).toBe('100.00');
        expect(cancelled.body.direction).toBe('IN');

        const reversal = await prisma.client.financialTransaction.findFirst({
          where: { reversalOfId: created.body.id },
        });
        expect(reversal).not.toBeNull();
        expect(reversal!.direction).toBe('OUT');
        expect(reversal!.amount.toString()).toBe('100');
        expect(reversal!.currency).toBe('UZS');

        const balance = await request(app.getHttpServer())
          .get(`/projects/${project.id}/finances/balance`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(balance.body.uzs).toBe('0.00');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects cancelling an already-cancelled transaction', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const created = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '100.00',
            currency: 'UZS',
            source: 'x',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances/${created.body.id}/cancel`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({ reason: 'first cancel' })
          .expect(200);

        const response = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances/${created.body.id}/cancel`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({ reason: 'second cancel attempt' })
          .expect(409);
        expect(response.body.code).toBe('TRANSACTION_ALREADY_CANCELLED');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects cancelling a reversal row itself', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const created = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '100.00',
            currency: 'UZS',
            source: 'x',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances/${created.body.id}/cancel`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({ reason: 'first cancel' })
          .expect(200);

        const reversal =
          await prisma.client.financialTransaction.findFirstOrThrow({
            where: { reversalOfId: created.body.id },
          });

        const response = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances/${reversal.id}/cancel`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({ reason: 'cancel the reversal' })
          .expect(409);
        expect(response.body.code).toBe('TRANSACTION_ALREADY_CANCELLED');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects cancelling an income that would overdraw the project', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const income = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '100.00',
            currency: 'UZS',
            source: 'x',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        // Spend the entire income so nothing is left to reverse the income against.
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'EXPENSE',
            amount: '100.00',
            currency: 'UZS',
            recipient: 'x',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        const response = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances/${income.body.id}/cancel`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({ reason: 'would overdraw' })
          .expect(409);
        expect(response.body.code).toBe('INSUFFICIENT_CASH');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects cancellation with no Idempotency-Key header', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const created = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '100.00',
            currency: 'UZS',
            source: 'x',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances/${created.body.id}/cancel`)
          .set('Authorization', `Bearer ${token}`)
          .send({ reason: 'no key' })
          .expect(400);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('replays an identical retried cancellation with the same result', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const created = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '100.00',
            currency: 'UZS',
            source: 'x',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        const key = idem();
        const first = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances/${created.body.id}/cancel`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', key)
          .send({ reason: 'mistake' })
          .expect(200);
        const second = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances/${created.body.id}/cancel`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', key)
          .send({ reason: 'mistake' })
          .expect(200);

        expect(second.body.cancelledAt).toBe(first.body.cancelledAt);

        const reversalCount = await prisma.client.financialTransaction.count({
          where: { reversalOfId: created.body.id },
        });
        expect(reversalCount).toBe(1);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });
});
