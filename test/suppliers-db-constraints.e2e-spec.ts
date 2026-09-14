import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { setupApp } from '../src/setup-app.js';
import {
  createTestProject,
  createTestPurchase,
  createTestSupplier,
  createTestUser,
  createTestWarehouse,
  deleteTestProject,
  nextTestSequence,
} from './fixtures/auth.fixture.js';

describe('Supplier/purchase database constraints (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let projectId: string;
  let userId: string;
  let supplierId: string;
  let purchaseId: string;

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
      `Supplier Constraint Test ${randomUUID()}`,
    );
    const user = await createTestUser(prisma.client);
    const supplier = await createTestSupplier(prisma.client, project.id);
    const warehouse = await createTestWarehouse(prisma.client, project.id);
    const purchase = await createTestPurchase(
      prisma.client,
      project.id,
      supplier.id,
      warehouse.id,
      user.id,
      {
        currency: 'USD',
        exchangeRate: '12500.00000000',
        totalAmount: '1000.00',
        totalAmountUzs: '12500000.00',
      },
    );
    projectId = project.id;
    userId = user.id;
    supplierId = supplier.id;
    purchaseId = purchase.id;
  });

  afterEach(async () => {
    await deleteTestProject(prisma.client, projectId);
  });

  async function operationData(kind: string) {
    return {
      projectId,
      actorId: userId,
      kind,
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
      occurredAt: new Date('2026-09-14T00:00:00.000Z'),
      sequence: await nextTestSequence(prisma.client, projectId),
    };
  }

  describe('Purchase constraints', () => {
    it('the immutability trigger rejects updating totalAmount', async () => {
      await expect(
        prisma.client.purchase.update({
          where: { id: purchaseId },
          data: { totalAmount: '999' },
        }),
      ).rejects.toThrow(/posted fields are immutable/);
    });

    it('the immutability trigger allows a legitimate one-time cancellation', async () => {
      await expect(
        prisma.client.purchase.update({
          where: { id: purchaseId },
          data: {
            cancelledAt: new Date(),
            cancellationReason: 'test',
            cancelledById: userId,
          },
        }),
      ).resolves.toBeDefined();
    });

    it('rejects a cancellation with only some of the three fields set', async () => {
      await expect(
        prisma.client.purchase.update({
          where: { id: purchaseId },
          data: { cancelledAt: new Date() },
        }),
      ).rejects.toThrow(/Purchase_cancellation_consistency_check/);
    });
  });

  describe('PurchaseItem constraints', () => {
    async function seedMaterial() {
      const category = await prisma.client.materialCategory.create({
        data: { projectId, name: `Cat ${randomUUID()}` },
      });
      const unit = await prisma.client.unit.create({
        data: {
          projectId,
          symbol: `u-${randomUUID().slice(0, 6)}`,
          name: 'Unit',
        },
      });
      return prisma.client.material.create({
        data: {
          projectId,
          categoryId: category.id,
          unitId: unit.id,
          name: 'Mat',
          code: `mat-${randomUUID()}`,
        },
      });
    }

    it('rejects a non-positive quantity', async () => {
      const material = await seedMaterial();
      await expect(
        prisma.client.purchaseItem.create({
          data: {
            purchaseId,
            lineNumber: 1,
            materialId: material.id,
            materialNameSnapshot: 'Mat',
            quantity: '0',
            unitPrice: '10',
            lineAmount: '100',
            lineAmountUzs: '100',
          },
        }),
      ).rejects.toThrow(/PurchaseItem_quantity_positive_check/);
    });

    it('the immutability trigger rejects any update', async () => {
      const material = await seedMaterial();
      const item = await prisma.client.purchaseItem.create({
        data: {
          purchaseId,
          lineNumber: 1,
          materialId: material.id,
          materialNameSnapshot: 'Mat',
          quantity: '10',
          unitPrice: '10',
          lineAmount: '100',
          lineAmountUzs: '100',
        },
      });
      await expect(
        prisma.client.purchaseItem.update({
          where: { id: item.id },
          data: { quantity: '999' },
        }),
      ).rejects.toThrow(/append-only/);
    });
  });

  describe('SupplierPayment constraints', () => {
    it('rejects a non-positive amount', async () => {
      const operation = await prisma.client.postedOperation.create({
        data: await operationData('test'),
      });
      await expect(
        prisma.client.supplierPayment.create({
          data: {
            projectId,
            operationId: operation.id,
            supplierId,
            purpose: 'DEBT_PAYMENT',
            currency: 'UZS',
            amount: '0',
            exchangeRate: '1',
            amountUzs: '100',
            createdById: userId,
          },
        }),
      ).rejects.toThrow(/SupplierPayment_amount_positive_check/);
    });

    it('rejects a UZS row whose exchangeRate is not exactly 1', async () => {
      const operation = await prisma.client.postedOperation.create({
        data: await operationData('test'),
      });
      await expect(
        prisma.client.supplierPayment.create({
          data: {
            projectId,
            operationId: operation.id,
            supplierId,
            purpose: 'DEBT_PAYMENT',
            currency: 'UZS',
            amount: '100',
            exchangeRate: '2',
            amountUzs: '200',
            createdById: userId,
          },
        }),
      ).rejects.toThrow(/SupplierPayment_currency_exchangeRate_check/);
    });
  });

  describe('SupplierAdvance constraints', () => {
    it('rejects a non-positive fundedAmount', async () => {
      const operation = await prisma.client.postedOperation.create({
        data: await operationData('test'),
      });
      const payment = await prisma.client.supplierPayment.create({
        data: {
          projectId,
          operationId: operation.id,
          supplierId,
          purpose: 'ADVANCE_FUNDING',
          currency: 'UZS',
          amount: '100',
          exchangeRate: '1',
          amountUzs: '100',
          createdById: userId,
        },
      });
      await expect(
        prisma.client.supplierAdvance.create({
          data: {
            projectId,
            supplierId,
            fundingPaymentId: payment.id,
            currency: 'UZS',
            fundedAmount: '0',
            fundedAmountUzs: '100',
          },
        }),
      ).rejects.toThrow(/SupplierAdvance_fundedAmount_positive_check/);
    });

    it('rejects a non-positive fundedAmountUzs', async () => {
      const operation = await prisma.client.postedOperation.create({
        data: await operationData('test'),
      });
      const payment = await prisma.client.supplierPayment.create({
        data: {
          projectId,
          operationId: operation.id,
          supplierId,
          purpose: 'ADVANCE_FUNDING',
          currency: 'UZS',
          amount: '100',
          exchangeRate: '1',
          amountUzs: '100',
          createdById: userId,
        },
      });
      await expect(
        prisma.client.supplierAdvance.create({
          data: {
            projectId,
            supplierId,
            fundingPaymentId: payment.id,
            currency: 'UZS',
            fundedAmount: '100',
            fundedAmountUzs: '0',
          },
        }),
      ).rejects.toThrow(/SupplierAdvance_fundedAmountUzs_positive_check/);
    });

    it('the append-only trigger rejects any update', async () => {
      const operation = await prisma.client.postedOperation.create({
        data: await operationData('test'),
      });
      const payment = await prisma.client.supplierPayment.create({
        data: {
          projectId,
          operationId: operation.id,
          supplierId,
          purpose: 'ADVANCE_FUNDING',
          currency: 'UZS',
          amount: '100',
          exchangeRate: '1',
          amountUzs: '100',
          createdById: userId,
        },
      });
      const advance = await prisma.client.supplierAdvance.create({
        data: {
          projectId,
          supplierId,
          fundingPaymentId: payment.id,
          currency: 'UZS',
          fundedAmount: '100',
          fundedAmountUzs: '100',
        },
      });
      await expect(
        prisma.client.supplierAdvance.update({
          where: { id: advance.id },
          data: { fundedAmount: '999' },
        }),
      ).rejects.toThrow(/append-only/);
    });
  });

  describe('SettlementAllocation constraints', () => {
    async function seedPayment() {
      const operation = await prisma.client.postedOperation.create({
        data: await operationData('test'),
      });
      return prisma.client.supplierPayment.create({
        data: {
          projectId,
          operationId: operation.id,
          supplierId,
          purpose: 'DEBT_PAYMENT',
          currency: 'USD',
          amount: '100',
          exchangeRate: '12500',
          rateOverrideReason: 'test fixture rate',
          amountUzs: '1250000',
          createdById: userId,
        },
      });
    }

    it('rejects neither fundingPaymentId nor advanceId set', async () => {
      const payment = await seedPayment();
      void payment;
      const operation = await prisma.client.postedOperation.create({
        data: await operationData('test2'),
      });
      await expect(
        prisma.client.settlementAllocation.create({
          data: {
            projectId,
            operationId: operation.id,
            supplierId,
            purchaseId,
            settlementCurrency: 'USD',
            settlementAmount: '100',
            settlementValueUzs: '1250000',
            debtCurrency: 'USD',
            debtAmountSettled: '100',
            exchangeDifferenceUzs: '0',
            createdById: userId,
          },
        }),
      ).rejects.toThrow(/SettlementAllocation_funding_source_xor_check/);
    });

    it('rejects a same-currency settlement carrying a rate', async () => {
      const payment = await seedPayment();
      const operation = await prisma.client.postedOperation.create({
        data: await operationData('test2'),
      });
      await expect(
        prisma.client.settlementAllocation.create({
          data: {
            projectId,
            operationId: operation.id,
            supplierId,
            purchaseId,
            fundingPaymentId: payment.id,
            settlementCurrency: 'USD',
            settlementAmount: '100',
            settlementValueUzs: '1250000',
            debtCurrency: 'USD',
            settlementExchangeRate: '12500',
            debtAmountSettled: '100',
            exchangeDifferenceUzs: '0',
            createdById: userId,
          },
        }),
      ).rejects.toThrow(/SettlementAllocation_settlementExchangeRate_check/);
    });

    it('accepts a valid same-currency (case 1) allocation', async () => {
      const payment = await seedPayment();
      const operation = await prisma.client.postedOperation.create({
        data: await operationData('test2'),
      });
      await expect(
        prisma.client.settlementAllocation.create({
          data: {
            projectId,
            operationId: operation.id,
            supplierId,
            purchaseId,
            fundingPaymentId: payment.id,
            settlementCurrency: 'USD',
            settlementAmount: '100',
            settlementValueUzs: '1250000',
            debtCurrency: 'USD',
            debtAmountSettled: '100',
            exchangeDifferenceUzs: '0',
            createdById: userId,
          },
        }),
      ).resolves.toBeDefined();
    });

    it('the append-only trigger rejects any update', async () => {
      const payment = await seedPayment();
      const operation = await prisma.client.postedOperation.create({
        data: await operationData('test2'),
      });
      const allocation = await prisma.client.settlementAllocation.create({
        data: {
          projectId,
          operationId: operation.id,
          supplierId,
          purchaseId,
          fundingPaymentId: payment.id,
          settlementCurrency: 'USD',
          settlementAmount: '100',
          settlementValueUzs: '1250000',
          debtCurrency: 'USD',
          debtAmountSettled: '100',
          exchangeDifferenceUzs: '0',
          createdById: userId,
        },
      });
      await expect(
        prisma.client.settlementAllocation.update({
          where: { id: allocation.id },
          data: { debtAmountSettled: '999' },
        }),
      ).rejects.toThrow(/append-only/);
    });
  });
});
