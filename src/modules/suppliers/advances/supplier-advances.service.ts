import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { computeRequestHash } from '../../../common/idempotency/request-hash.util.js';
import { isFutureBusinessDate } from '../../../common/date/business-date.util.js';
import { computeAmountUzs } from '../../../common/money/decimal.util.js';
import { ProjectLockService } from '../../../database/project-lock.service.js';
import { PrismaService } from '../../../database/prisma.service.js';
import {
  FinancialTransactionType,
  Prisma,
  SupplierAdvance,
} from '../../../generated/prisma/client.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { FinancialPostingService } from '../../finances/financial-posting.service.js';
import { ProjectAccessAction } from '../../projects/project-access-action.enum.js';
import { ProjectAccessService } from '../../projects/project-access.service.js';
import { CreateSupplierAdvanceDto } from './dto/create-supplier-advance.dto.js';
import { SupplierAdvanceResponseDto } from './dto/supplier-advance-response.dto.js';

const ADVANCE_CREATE_KIND = 'supplier_advance.create';

@Injectable()
export class SupplierAdvancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly projectLock: ProjectLockService,
    private readonly financialPosting: FinancialPostingService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Funds a supplier advance — cash decreases, the advance's available
   * balance increases, atomically (this phase's §6.3/§6.13). Uses
   * `FinancialPostingService.postCashEffect` for the actual cash row so the
   * balance check/Decimal rules/rate resolution are byte-for-byte the same
   * as every other cash-moving workflow — no parallel accounting system.
   */
  async create(
    user: AuthenticatedUser,
    projectId: string,
    supplierId: string,
    dto: CreateSupplierAdvanceDto,
    idempotencyKey: string,
    requestId?: string,
  ): Promise<{ advance: SupplierAdvanceResponseDto; isReplay: boolean }> {
    const requestHash = computeRequestHash({
      kind: ADVANCE_CREATE_KIND,
      projectId,
      supplierId,
      currency: dto.currency,
      amount: dto.amount,
      exchangeRate: dto.exchangeRate,
      currencyRateId: dto.currencyRateId,
      rateOverrideReason: dto.rateOverrideReason,
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
              kind: ADVANCE_CREATE_KIND,
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
          const existingPayment = await tx.supplierPayment.findFirst({
            where: { operationId: existingOperation.id },
          });
          const existingAdvance = existingPayment
            ? await tx.supplierAdvance.findFirst({
                where: { fundingPaymentId: existingPayment.id },
              })
            : null;
          if (!existingAdvance) {
            throw new NotFoundException({
              code: 'NOT_FOUND',
              message: 'Replayed advance not found',
            });
          }
          return {
            advance: await this.toResponse(tx, existingAdvance),
            isReplay: true,
          };
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

        if (isFutureBusinessDate(dto.occurredAt, project.timezone)) {
          throw new ConflictException({
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
        const amount = new Prisma.Decimal(dto.amount);
        const amountUzs = computeAmountUzs(amount, exchangeRate);
        const occurredAt = new Date(`${dto.occurredAt}T00:00:00.000Z`);

        const sequence = await this.projectLock.bumpPostingSequence(
          tx,
          projectId,
        );
        const operation = await tx.postedOperation.create({
          data: {
            projectId,
            actorId: user.id,
            kind: ADVANCE_CREATE_KIND,
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
            purpose: 'ADVANCE_FUNDING',
            currency: dto.currency,
            amount,
            exchangeRate,
            amountUzs,
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
          type: FinancialTransactionType.ADVANCE,
          amount,
          currency: dto.currency,
          exchangeRate,
          amountUzs,
          rateSource,
          rateId,
          rateOverrideReason,
          recipient: supplier.name,
          comment: dto.comment,
          occurredAt,
          createdById: user.id,
          supplierPaymentId: payment.id,
        });

        const advance = await tx.supplierAdvance.create({
          data: {
            projectId,
            supplierId,
            fundingPaymentId: payment.id,
            currency: dto.currency,
            fundedAmount: amount,
            fundedAmountUzs: amountUzs,
          },
        });

        await this.audit.record(tx, {
          projectId,
          actorId: user.id,
          action: 'supplier_advance.create',
          entityType: 'SupplierAdvance',
          entityId: advance.id,
          operationId: operation.id,
          requestId,
          newData: { ...(await this.toResponse(tx, advance)) },
        });

        return { advance: await this.toResponse(tx, advance), isReplay: false };
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
                kind: ADVANCE_CREATE_KIND,
                idempotencyKey,
              },
            },
          });
        if (
          existingOperation &&
          existingOperation.requestHash === requestHash
        ) {
          const payment = await this.prisma.client.supplierPayment.findFirst({
            where: { operationId: existingOperation.id },
          });
          const advance = payment
            ? await this.prisma.client.supplierAdvance.findFirst({
                where: { fundingPaymentId: payment.id },
              })
            : null;
          if (advance) {
            return {
              advance: await this.toResponse(this.prisma.client, advance),
              isReplay: true,
            };
          }
        }
      }
      throw error;
    }
  }

  private async toResponse(
    client: Prisma.TransactionClient | typeof this.prisma.client,
    advance: SupplierAdvance,
  ): Promise<SupplierAdvanceResponseDto> {
    const consumed = await client.settlementAllocation.groupBy({
      by: ['effect'],
      where: { advanceId: advance.id },
      _sum: { settlementAmount: true },
    });
    let applied = new Prisma.Decimal(0);
    let reversed = new Prisma.Decimal(0);
    for (const row of consumed) {
      if (row.effect === 'APPLY') {
        applied = row._sum.settlementAmount ?? applied;
      } else {
        reversed = row._sum.settlementAmount ?? reversed;
      }
    }
    const available = advance.fundedAmount.minus(applied).plus(reversed);

    return {
      id: advance.id,
      projectId: advance.projectId,
      supplierId: advance.supplierId,
      fundingPaymentId: advance.fundingPaymentId,
      currency: advance.currency,
      fundedAmount: advance.fundedAmount.toFixed(2),
      fundedAmountUzs: advance.fundedAmountUzs.toFixed(2),
      availableAmount: available.toFixed(2),
      createdAt: advance.createdAt,
    };
  }
}
