import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { computeRequestHash } from '../../../common/idempotency/request-hash.util.js';
import { isFutureBusinessDate } from '../../../common/date/business-date.util.js';
import {
  computeAmountUzs,
  round2,
} from '../../../common/money/decimal.util.js';
import { computeRemainingDebt } from '../../../common/settlement/purchase-debt.util.js';
import { ProjectLockService } from '../../../database/project-lock.service.js';
import { PrismaService } from '../../../database/prisma.service.js';
import {
  Currency,
  FinancialTransactionType,
  Prisma,
  SettlementAllocation,
} from '../../../generated/prisma/client.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { FinancialPostingService } from '../../finances/financial-posting.service.js';
import { ProjectAccessAction } from '../../projects/project-access-action.enum.js';
import { ProjectAccessService } from '../../projects/project-access.service.js';
import { CreateDebtPaymentDto } from './dto/create-debt-payment.dto.js';
import { SettlementAllocationResponseDto } from './dto/settlement-allocation-response.dto.js';

const DEBT_PAYMENT_CREATE_KIND = 'debt_payment.create';

/**
 * Implements transaction-design.md §5's three-case cross-currency
 * settlement formula exactly. `debtCurrency` here is always the target
 * purchase's own currency (immutable, never converted).
 */
@Injectable()
export class DebtPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly projectLock: ProjectLockService,
    private readonly financialPosting: FinancialPostingService,
    private readonly audit: AuditService,
  ) {}

  async create(
    user: AuthenticatedUser,
    projectId: string,
    supplierId: string,
    dto: CreateDebtPaymentDto,
    idempotencyKey: string,
    requestId?: string,
  ): Promise<{
    allocation: SettlementAllocationResponseDto;
    isReplay: boolean;
  }> {
    const requestHash = computeRequestHash({
      kind: DEBT_PAYMENT_CREATE_KIND,
      projectId,
      supplierId,
      purchaseId: dto.purchaseId,
      currency: dto.currency,
      amount: dto.amount,
      exchangeRate: dto.exchangeRate,
      currencyRateId: dto.currencyRateId,
      rateOverrideReason: dto.rateOverrideReason,
      settlementExchangeRate: dto.settlementExchangeRate,
      comment: dto.comment,
      occurredAt: dto.occurredAt,
    });

    try {
      return await this.projectLock.runExclusive(projectId, async (tx) => {
        const { project } = await this.projectAccess.assertAccessInTransaction(
          tx,
          user.id,
          projectId,
          ProjectAccessAction.WRITE,
        );

        const existingOperation = await tx.postedOperation.findUnique({
          where: {
            projectId_actorId_kind_idempotencyKey: {
              projectId,
              actorId: user.id,
              kind: DEBT_PAYMENT_CREATE_KIND,
              idempotencyKey,
            },
          },
        });
        if (existingOperation) {
          if (existingOperation.requestHash !== requestHash) {
            throw new ConflictException({
              code: 'IDEMPOTENCY_KEY_REUSED',
              message:
                'This Idempotency-Key was already used with a different request payload',
            });
          }
          const existing = await tx.settlementAllocation.findFirst({
            where: { operationId: existingOperation.id },
          });
          if (!existing) {
            throw new NotFoundException({
              code: 'NOT_FOUND',
              message: 'Replayed allocation not found',
            });
          }
          return { allocation: this.toResponse(existing), isReplay: true };
        }

        const supplier = await tx.supplier.findFirst({
          where: { id: supplierId, projectId },
        });
        if (!supplier || !supplier.isActive) {
          throw new NotFoundException({
            code: 'NOT_FOUND',
            message: 'Supplier not found in this project',
          });
        }

        const purchase = await tx.purchase.findFirst({
          where: { id: dto.purchaseId, projectId, supplierId },
        });
        if (!purchase) {
          throw new NotFoundException({
            code: 'NOT_FOUND',
            message: 'Purchase not found for this supplier',
          });
        }
        if (purchase.cancelledAt) {
          throw new ConflictException({
            code: 'PURCHASE_ALREADY_CANCELLED',
            message:
              'This purchase has been cancelled and cannot receive payments',
          });
        }

        if (isFutureBusinessDate(dto.occurredAt, project.timezone)) {
          throw new BadRequestException({
            code: 'VALIDATION_ERROR',
            message: 'occurredAt cannot be a future business date',
          });
        }

        const { exchangeRate, rateId, rateOverrideReason, rateSource } =
          await this.financialPosting.resolveRate(
            tx,
            projectId,
            dto.currency,
            dto,
          );
        const settlementAmount = new Prisma.Decimal(dto.amount);
        const settlementValueUzs = computeAmountUzs(
          settlementAmount,
          exchangeRate,
        );

        // transaction-design.md §5's three cases, discriminated entirely by
        // currency, never by caller choice.
        let debtAmountSettled: Prisma.Decimal;
        let settlementExchangeRate: Prisma.Decimal | null = null;
        if (dto.currency === purchase.currency) {
          // Case 1: no conversion at all.
          if (dto.settlementExchangeRate !== undefined) {
            throw new BadRequestException({
              code: 'VALIDATION_ERROR',
              message:
                'settlementExchangeRate must not be supplied when the payment currency matches the debt currency',
            });
          }
          debtAmountSettled = settlementAmount;
        } else if (purchase.currency === Currency.UZS) {
          // Case 2: debt is UZS, payment is foreign — use the payment's own
          // already-required rate, no new confirmation needed.
          if (dto.settlementExchangeRate !== undefined) {
            throw new BadRequestException({
              code: 'VALIDATION_ERROR',
              message:
                'settlementExchangeRate must not be supplied when the debt currency is UZS',
            });
          }
          debtAmountSettled = settlementValueUzs;
        } else {
          // Case 3: both currencies differ and neither is UZS's trivial
          // case — an explicit, caller-confirmed rate is mandatory.
          if (dto.settlementExchangeRate === undefined) {
            throw new ConflictException({
              code: 'SETTLEMENT_RATE_REQUIRED',
              message:
                'settlementExchangeRate is required to settle a foreign-currency debt with a different-currency payment',
            });
          }
          settlementExchangeRate = new Prisma.Decimal(
            dto.settlementExchangeRate,
          );
          if (!settlementExchangeRate.greaterThan(0)) {
            throw new ConflictException({
              code: 'SETTLEMENT_RATE_REQUIRED',
              message: 'settlementExchangeRate must be positive',
            });
          }
          debtAmountSettled = round2(
            settlementValueUzs.dividedBy(settlementExchangeRate),
          );
        }

        const remainingDebt = await computeRemainingDebt(
          tx,
          purchase.id,
          purchase.totalAmount,
        );
        if (debtAmountSettled.greaterThan(remainingDebt)) {
          throw new ConflictException({
            code: 'DEBT_PAYMENT_EXCEEDS_REMAINING',
            message: `Payment would settle ${debtAmountSettled.toFixed(2)} ${purchase.currency} but only ${remainingDebt.toFixed(2)} remains`,
          });
        }

        // Informational only — never affects debt or cash arithmetic
        // (transaction-design.md §5).
        const purchaseRateAtInvoice =
          purchase.currency === Currency.UZS
            ? new Prisma.Decimal(1)
            : purchase.exchangeRate;
        const exchangeDifferenceUzs = settlementValueUzs.minus(
          round2(debtAmountSettled.mul(purchaseRateAtInvoice)),
        );

        const occurredAt = new Date(`${dto.occurredAt}T00:00:00.000Z`);
        const sequence = await this.projectLock.bumpPostingSequence(
          tx,
          projectId,
        );
        const operation = await tx.postedOperation.create({
          data: {
            projectId,
            actorId: user.id,
            kind: DEBT_PAYMENT_CREATE_KIND,
            idempotencyKey,
            requestHash,
            occurredAt,
            sequence,
          },
        });

        const payment = await tx.supplierPayment.create({
          data: {
            projectId,
            operationId: operation.id,
            supplierId,
            purpose: 'DEBT_PAYMENT',
            currency: dto.currency,
            amount: settlementAmount,
            exchangeRate,
            amountUzs: settlementValueUzs,
            rateSource,
            rateId,
            rateOverrideReason,
            comment: dto.comment,
            createdById: user.id,
          },
        });

        await this.financialPosting.postCashEffect(tx, {
          projectId,
          operationId: operation.id,
          type: FinancialTransactionType.DEBT_PAYMENT,
          amount: settlementAmount,
          currency: dto.currency,
          exchangeRate,
          amountUzs: settlementValueUzs,
          rateSource,
          rateId,
          rateOverrideReason,
          recipient: supplier.name,
          comment: dto.comment,
          occurredAt,
          createdById: user.id,
          supplierPaymentId: payment.id,
        });

        const allocation = await tx.settlementAllocation.create({
          data: {
            projectId,
            operationId: operation.id,
            supplierId,
            purchaseId: purchase.id,
            fundingPaymentId: payment.id,
            settlementCurrency: dto.currency,
            settlementAmount,
            settlementValueUzs,
            debtCurrency: purchase.currency,
            settlementExchangeRate,
            debtAmountSettled,
            exchangeDifferenceUzs,
            effect: 'APPLY',
            createdById: user.id,
          },
        });

        await this.audit.record(tx, {
          projectId,
          actorId: user.id,
          action: DEBT_PAYMENT_CREATE_KIND,
          entityType: 'SettlementAllocation',
          entityId: allocation.id,
          operationId: operation.id,
          requestId,
          newData: { ...this.toResponse(allocation) },
        });

        return { allocation: this.toResponse(allocation), isReplay: false };
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { name?: unknown }).name ===
          'PrismaClientKnownRequestError' &&
        (error as { code?: unknown }).code === 'P2002'
      ) {
        const existingOperation =
          await this.prisma.client.postedOperation.findUnique({
            where: {
              projectId_actorId_kind_idempotencyKey: {
                projectId,
                actorId: user.id,
                kind: DEBT_PAYMENT_CREATE_KIND,
                idempotencyKey,
              },
            },
          });
        if (
          existingOperation &&
          existingOperation.requestHash === requestHash
        ) {
          const existing =
            await this.prisma.client.settlementAllocation.findFirst({
              where: { operationId: existingOperation.id },
            });
          if (existing) {
            return { allocation: this.toResponse(existing), isReplay: true };
          }
        }
      }
      throw error;
    }
  }

  private toResponse(
    allocation: SettlementAllocation,
  ): SettlementAllocationResponseDto {
    return {
      id: allocation.id,
      purchaseId: allocation.purchaseId,
      fundingPaymentId: allocation.fundingPaymentId,
      advanceId: allocation.advanceId,
      settlementCurrency: allocation.settlementCurrency,
      settlementAmount: allocation.settlementAmount.toFixed(2),
      settlementValueUzs: allocation.settlementValueUzs.toFixed(2),
      debtCurrency: allocation.debtCurrency,
      settlementExchangeRate: allocation.settlementExchangeRate
        ? allocation.settlementExchangeRate.toFixed(8)
        : null,
      debtAmountSettled: allocation.debtAmountSettled.toFixed(2),
      exchangeDifferenceUzs: allocation.exchangeDifferenceUzs.toFixed(2),
      effect: allocation.effect,
      createdAt: allocation.createdAt,
    };
  }
}
