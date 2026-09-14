import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { setupApp } from '../src/setup-app.js';
import {
  createTestProject,
  createTestUser,
  deleteTestProject,
} from './fixtures/auth.fixture.js';

/**
 * Direct-database verification of every hand-written CHECK constraint,
 * composite FK, and immutability trigger this phase's migrations add —
 * bypassing the service layer entirely (raw `prisma.client.<model>.create`/
 * `.update`, never going through `FinancialPostingService`) so these tests
 * prove the DATABASE itself rejects invalid states, independent of whether
 * application code has a bug. Every scenario here was first proven manually
 * against a real psql session while building the migrations
 * (prisma/migrations/2026091408*); this file keeps that proof running
 * permanently. See docs/adr/0008-manual-sql-check-constraints.md.
 */
describe('Finance database constraints (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let projectId: string;
  let userId: string;
  let operationId: string;

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

  beforeEach(async () => {
    const project = await createTestProject(
      prisma.client,
      `Constraint Test ${randomUUID()}`,
    );
    const user = await createTestUser(prisma.client);
    projectId = project.id;
    userId = user.id;
    const operation = await prisma.client.postedOperation.create({
      data: {
        projectId,
        actorId: userId,
        kind: 'financial_transaction.create',
        idempotencyKey: randomUUID(),
        requestHash: 'hash',
        occurredAt: new Date('2026-09-14T00:00:00.000Z'),
        sequence: 1,
      },
    });
    operationId = operation.id;
  });

  afterEach(async () => {
    await deleteTestProject(prisma.client, projectId);
  });

  function baseTxData(overrides: Record<string, unknown> = {}) {
    return {
      projectId,
      operationId,
      type: 'INCOME' as const,
      direction: 'IN' as const,
      amount: '100.00',
      currency: 'UZS' as const,
      exchangeRate: '1',
      amountUzs: '100.00',
      occurredAt: new Date('2026-09-14T00:00:00.000Z'),
      createdById: userId,
      ...overrides,
    };
  }

  describe('PostedOperation constraints', () => {
    it('rejects sequence <= 0', async () => {
      await expect(
        prisma.client.postedOperation.create({
          data: {
            projectId,
            actorId: userId,
            kind: 'test',
            idempotencyKey: randomUUID(),
            requestHash: 'hash',
            occurredAt: new Date('2026-09-14T00:00:00.000Z'),
            sequence: 0,
          },
        }),
      ).rejects.toThrow(/PostedOperation_sequence_positive_check/);
    });

    it('rejects a cancellationReason without cancelledAt', async () => {
      await expect(
        prisma.client.postedOperation.create({
          data: {
            projectId,
            actorId: userId,
            kind: 'test',
            idempotencyKey: randomUUID(),
            requestHash: 'hash',
            occurredAt: new Date('2026-09-14T00:00:00.000Z'),
            sequence: 99,
            cancellationReason: 'orphaned reason',
          },
        }),
      ).rejects.toThrow(/PostedOperation_cancellation_consistency_check/);
    });

    it('rejects an operation whose reversalOfId points to itself', async () => {
      const id = randomUUID();
      await expect(
        prisma.client.postedOperation.create({
          data: {
            id,
            projectId,
            actorId: userId,
            kind: 'test',
            idempotencyKey: randomUUID(),
            requestHash: 'hash',
            occurredAt: new Date('2026-09-14T00:00:00.000Z'),
            sequence: 99,
            reversalOfId: id,
          },
        }),
      ).rejects.toThrow(/PostedOperation_reversal_not_self_check/);
    });

    it('the immutability trigger rejects updating a posted field', async () => {
      await expect(
        prisma.client.postedOperation.update({
          where: { id: operationId },
          data: { sequence: 999 },
        }),
      ).rejects.toThrow(/posted fields are immutable/);
    });

    it('a legitimate cancellation update succeeds', async () => {
      await expect(
        prisma.client.postedOperation.update({
          where: { id: operationId },
          data: { cancelledAt: new Date(), cancellationReason: 'test' },
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('FinancialTransaction constraints', () => {
    it('rejects amount <= 0', async () => {
      await expect(
        prisma.client.financialTransaction.create({
          data: baseTxData({ amount: '0.00' }),
        }),
      ).rejects.toThrow(/FinancialTransaction_amount_positive_check/);
    });

    it('rejects amountUzs <= 0', async () => {
      await expect(
        prisma.client.financialTransaction.create({
          data: baseTxData({ amountUzs: '0.00' }),
        }),
      ).rejects.toThrow(/FinancialTransaction_amountUzs_positive_check/);
    });

    it('rejects a UZS row whose exchangeRate is not exactly 1', async () => {
      await expect(
        prisma.client.financialTransaction.create({
          data: baseTxData({ exchangeRate: '2.00000000' }),
        }),
      ).rejects.toThrow(/FinancialTransaction_currency_exchangeRate_check/);
    });

    it('rejects a USD row with a non-positive exchangeRate', async () => {
      await expect(
        prisma.client.financialTransaction.create({
          data: baseTxData({
            currency: 'USD',
            exchangeRate: '0',
            rateOverrideReason: 'test',
          }),
        }),
      ).rejects.toThrow(/FinancialTransaction_currency_exchangeRate_check/);
    });

    it('rejects a mismatched type/direction pair', async () => {
      await expect(
        prisma.client.financialTransaction.create({
          data: baseTxData({ type: 'EXPENSE', direction: 'IN' }),
        }),
      ).rejects.toThrow(/FinancialTransaction_direction_matches_type_check/);
    });

    it('allows a reversal row to carry the opposite direction of its type', async () => {
      const original = await prisma.client.financialTransaction.create({
        data: baseTxData(),
      });
      const reversalOperation = await prisma.client.postedOperation.create({
        data: {
          projectId,
          actorId: userId,
          kind: 'financial_transaction.cancel',
          idempotencyKey: randomUUID(),
          requestHash: 'hash2',
          occurredAt: new Date('2026-09-14T00:00:00.000Z'),
          sequence: 2,
          reversalOfId: operationId,
        },
      });
      await expect(
        prisma.client.financialTransaction.create({
          data: baseTxData({
            operationId: reversalOperation.id,
            direction: 'OUT',
            reversalOfId: original.id,
          }),
        }),
      ).resolves.toBeDefined();
    });

    it('rejects a USD row with both rateId and rateOverrideReason', async () => {
      const rate = await prisma.client.currencyRate.create({
        data: {
          projectId,
          currency: 'USD',
          rateUzs: '12500.00000000',
          effectiveOn: new Date('2026-09-14T00:00:00.000Z'),
          createdById: userId,
        },
      });
      await expect(
        prisma.client.financialTransaction.create({
          data: baseTxData({
            currency: 'USD',
            exchangeRate: '12500.00000000',
            rateId: rate.id,
            rateOverrideReason: 'conflicting',
          }),
        }),
      ).rejects.toThrow(/FinancialTransaction_rate_consistency_check/);
    });

    it('rejects a USD row with neither rateId nor rateOverrideReason', async () => {
      await expect(
        prisma.client.financialTransaction.create({
          data: baseTxData({ currency: 'USD', exchangeRate: '12500.00000000' }),
        }),
      ).rejects.toThrow(/FinancialTransaction_rate_consistency_check/);
    });

    it('rejects a cancellation with only some of the three fields set', async () => {
      const created = await prisma.client.financialTransaction.create({
        data: baseTxData(),
      });
      await expect(
        prisma.client.financialTransaction.update({
          where: { id: created.id },
          data: { cancelledAt: new Date() },
        }),
      ).rejects.toThrow(/FinancialTransaction_cancellation_consistency_check/);
    });

    it('rejects a row whose reversalOfId points to itself', async () => {
      const id = randomUUID();
      await expect(
        prisma.client.financialTransaction.create({
          data: baseTxData({ id, reversalOfId: id }),
        }),
      ).rejects.toThrow(/FinancialTransaction_reversal_not_self_check/);
    });

    it('rejects a categoryId belonging to a different project (composite FK)', async () => {
      const other = await createTestProject(
        prisma.client,
        `Other ${randomUUID()}`,
      );
      try {
        const foreignCategory = await prisma.client.transactionCategory.create({
          data: { projectId: other.id, name: 'Foreign', kind: 'EXPENSE' },
        });
        await expect(
          prisma.client.financialTransaction.create({
            data: baseTxData({ categoryId: foreignCategory.id }),
          }),
        ).rejects.toThrow(/Foreign key constraint/);
      } finally {
        await deleteTestProject(prisma.client, other.id);
      }
    });

    it('allows a categoryId belonging to the same project', async () => {
      const category = await prisma.client.transactionCategory.create({
        data: { projectId, name: 'Same-project', kind: 'INCOME' },
      });
      await expect(
        prisma.client.financialTransaction.create({
          data: baseTxData({ categoryId: category.id }),
        }),
      ).resolves.toBeDefined();
    });

    it('the immutability trigger rejects updating amount', async () => {
      const created = await prisma.client.financialTransaction.create({
        data: baseTxData(),
      });
      await expect(
        prisma.client.financialTransaction.update({
          where: { id: created.id },
          data: { amount: '999.00' },
        }),
      ).rejects.toThrow(/posted fields are immutable/);
    });

    it('the immutability trigger allows editing comment at any time, including post-cancellation', async () => {
      const created = await prisma.client.financialTransaction.create({
        data: baseTxData(),
      });
      await prisma.client.financialTransaction.update({
        where: { id: created.id },
        data: {
          cancelledAt: new Date(),
          cancellationReason: 'x',
          cancelledById: userId,
        },
      });
      await expect(
        prisma.client.financialTransaction.update({
          where: { id: created.id },
          data: { comment: 'noted after cancellation' },
        }),
      ).resolves.toBeDefined();
    });

    it('the immutability trigger rejects a second cancellation', async () => {
      const created = await prisma.client.financialTransaction.create({
        data: baseTxData(),
      });
      await prisma.client.financialTransaction.update({
        where: { id: created.id },
        data: {
          cancelledAt: new Date(),
          cancellationReason: 'first',
          cancelledById: userId,
        },
      });
      await expect(
        prisma.client.financialTransaction.update({
          where: { id: created.id },
          data: { cancellationReason: 'changed my mind' },
        }),
      ).rejects.toThrow(/cancellation is final/);
    });
  });

  describe('CurrencyRate constraints', () => {
    it('rejects rateUzs <= 0', async () => {
      await expect(
        prisma.client.currencyRate.create({
          data: {
            projectId,
            currency: 'USD',
            rateUzs: '0',
            effectiveOn: new Date('2026-09-14T00:00:00.000Z'),
            createdById: userId,
          },
        }),
      ).rejects.toThrow(/CurrencyRate_rateUzs_positive_check/);
    });

    it('rejects UZS as the quoted currency', async () => {
      await expect(
        prisma.client.currencyRate.create({
          data: {
            projectId,
            currency: 'UZS',
            rateUzs: '1.00000000',
            effectiveOn: new Date('2026-09-14T00:00:00.000Z'),
            createdById: userId,
          },
        }),
      ).rejects.toThrow(/CurrencyRate_currency_not_base_check/);
    });

    it('the append-only trigger rejects any update at all', async () => {
      const rate = await prisma.client.currencyRate.create({
        data: {
          projectId,
          currency: 'USD',
          rateUzs: '12500.00000000',
          effectiveOn: new Date('2026-09-14T00:00:00.000Z'),
          createdById: userId,
        },
      });
      await expect(
        prisma.client.currencyRate.update({
          where: { id: rate.id },
          data: { rateUzs: '99999.00000000' },
        }),
      ).rejects.toThrow(/append-only/);
    });
  });

  describe('AuditLog constraints', () => {
    it('the append-only trigger rejects any update at all', async () => {
      const log = await prisma.client.auditLog.create({
        data: {
          projectId,
          actorId: userId,
          action: 'financial_transaction.create',
          entityType: 'FinancialTransaction',
          entityId: randomUUID(),
          newData: { amount: '1.00' },
        },
      });
      await expect(
        prisma.client.auditLog.update({
          where: { id: log.id },
          data: { action: 'tampered' },
        }),
      ).rejects.toThrow(/append-only/);
    });
  });
});
