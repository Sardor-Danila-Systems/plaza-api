import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { computeRequestHash } from '../../common/idempotency/request-hash.util.js';
import { isFutureBusinessDate } from '../../common/date/business-date.util.js';
import { computeAmountUzs, round2 } from '../../common/money/decimal.util.js';
import { distributeLargestRemainder } from '../../common/money/largest-remainder.util.js';
import { receiveStockByValue } from '../../common/inventory/costing.util.js';
import {
  hasLaterEffectiveMovement,
  loadReversedOperationIds,
} from '../../common/inventory/dependency-check.util.js';
import {
  SettlementRateRequiredError,
  computeExchangeDifferenceUzs,
  resolveSettlementCase,
} from '../../common/settlement/cross-currency-settlement.util.js';
import { computeRemainingDebt } from '../../common/settlement/purchase-debt.util.js';
import {
  PrismaTx,
  ProjectLockService,
} from '../../database/project-lock.service.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  Currency,
  FinancialTransactionType,
  Prisma,
  SettlementEffect,
  StockMovementType,
  TransactionDirection,
} from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { EditCommentDto } from '../finances/dto/edit-comment.dto.js';
import { FinancialPostingService } from '../finances/financial-posting.service.js';
import { ProjectAccessAction } from '../projects/project-access-action.enum.js';
import { ProjectAccessService } from '../projects/project-access.service.js';
import { CancelPurchaseDto } from './dto/cancel-purchase.dto.js';
import { CreatePurchaseDto } from './dto/create-purchase.dto.js';
import { ListPurchasesQueryDto } from './dto/list-purchases-query.dto.js';
import { PaginatedPurchasesResponseDto } from './dto/paginated-purchases-response.dto.js';
import { PurchaseItemResponseDto } from './dto/purchase-item-response.dto.js';
import {
  PurchaseResponseDto,
  PurchaseStatus,
} from './dto/purchase-response.dto.js';

const PURCHASE_CREATE_KIND = 'purchase.create';
const PURCHASE_CANCEL_KIND = 'purchase.cancel';

type PurchaseWithItems = Prisma.PurchaseGetPayload<{
  include: { items: true };
}>;

export interface CreatePurchaseResult {
  purchase: PurchaseResponseDto;
  isReplay: boolean;
}

export interface CancelPurchaseResult {
  purchase: PurchaseResponseDto;
  isReplay: boolean;
}

/**
 * `PurchasesService` — the orchestration transaction docs/transaction-design.md
 * §4 describes: one posted invoice, its material receipt, its settlement
 * (advance consumption and/or an immediate cash payment), and its audit
 * trail, all inside one project-locked Serializable transaction. This is
 * deliberately not CRUD: there is no update endpoint for any posted field,
 * only creation, read, comment-editing, and dependency-checked cancellation
 * (§8).
 */
@Injectable()
export class PurchasesService {
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
    dto: CreatePurchaseDto,
    idempotencyKey: string,
    requestId?: string,
  ): Promise<CreatePurchaseResult> {
    const requestHash = computeRequestHash({
      kind: PURCHASE_CREATE_KIND,
      projectId,
      supplierId: dto.supplierId,
      warehouseId: dto.warehouseId,
      currency: dto.currency,
      exchangeRate: dto.exchangeRate,
      currencyRateId: dto.currencyRateId,
      rateOverrideReason: dto.rateOverrideReason,
      items: dto.items.map((item) => ({
        materialId: item.materialId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
      advanceAllocations: (dto.advanceAllocations ?? []).map((a) => ({
        advanceId: a.advanceId,
        amount: a.amount,
        settlementExchangeRate: a.settlementExchangeRate,
      })),
      cashPaid: dto.cashPaid,
      invoiceNumber: dto.invoiceNumber,
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
              kind: PURCHASE_CREATE_KIND,
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
          const existing = await tx.purchase.findUnique({
            where: { operationId: existingOperation.id },
            include: { items: { orderBy: { lineNumber: 'asc' } } },
          });
          if (!existing) {
            throw new NotFoundException({
              code: 'NOT_FOUND',
              message: 'Replayed purchase not found',
            });
          }
          return {
            purchase: await this.toResponse(tx, existing),
            isReplay: true,
          };
        }

        if (isFutureBusinessDate(dto.occurredAt, project.timezone)) {
          throw new BadRequestException({
            code: 'VALIDATION_ERROR',
            message: 'occurredAt cannot be a future business date',
          });
        }

        // Step 1 — resolve every referenced entity via project-scoped
        // composite-FK queries, batched rather than one query per item
        // (transaction-design.md §4 step 1).
        const supplier = await tx.supplier.findFirst({
          where: { id: dto.supplierId, projectId },
        });
        if (!supplier || !supplier.isActive) {
          throw new NotFoundException({
            code: 'NOT_FOUND',
            message: 'Supplier not found in this project',
          });
        }

        const warehouse = await tx.warehouse.findFirst({
          where: { id: dto.warehouseId, projectId },
        });
        if (!warehouse || !warehouse.isActive) {
          throw new NotFoundException({
            code: 'NOT_FOUND',
            message: 'Warehouse not found in this project',
          });
        }

        // Step 2 — no duplicate material lines (MVP does not merge them).
        const materialIds = dto.items.map((item) => item.materialId);
        if (new Set(materialIds).size !== materialIds.length) {
          throw new BadRequestException({
            code: 'VALIDATION_ERROR',
            message: 'A purchase cannot list the same material more than once',
          });
        }
        const materials = await tx.material.findMany({
          where: { projectId, id: { in: materialIds } },
        });
        const materialsById = new Map(materials.map((m) => [m.id, m]));
        for (const materialId of materialIds) {
          const material = materialsById.get(materialId);
          if (!material || !material.isActive) {
            throw new NotFoundException({
              code: 'NOT_FOUND',
              message: 'Material not found in this project',
            });
          }
        }

        const advanceAllocationInputs = dto.advanceAllocations ?? [];
        const advanceIds = advanceAllocationInputs.map((a) => a.advanceId);
        if (new Set(advanceIds).size !== advanceIds.length) {
          throw new BadRequestException({
            code: 'VALIDATION_ERROR',
            message:
              'A purchase cannot allocate the same advance more than once',
          });
        }
        const advances = await tx.supplierAdvance.findMany({
          where: {
            projectId,
            supplierId: dto.supplierId,
            id: { in: advanceIds },
          },
        });
        const advancesById = new Map(advances.map((a) => [a.id, a]));
        for (const advanceId of advanceIds) {
          if (!advancesById.has(advanceId)) {
            throw new NotFoundException({
              code: 'NOT_FOUND',
              message: 'Supplier advance not found for this supplier',
            });
          }
        }

        const { exchangeRate, rateId, rateOverrideReason, rateSource } =
          await this.financialPosting.resolveRate(
            tx,
            projectId,
            dto.currency,
            dto,
          );

        // Step 3 — line totals in the purchase's own currency, never
        // trusting a client-supplied total, then one UZS conversion
        // distributed exactly across lines by largest remainder.
        const itemCalcs = dto.items.map((item) => {
          const quantity = new Prisma.Decimal(item.quantity);
          const unitPrice = new Prisma.Decimal(item.unitPrice);
          return {
            material: materialsById.get(item.materialId)!,
            quantity,
            unitPrice,
            lineAmount: round2(quantity.mul(unitPrice)),
          };
        });
        const totalAmount = itemCalcs.reduce(
          (sum, calc) => sum.plus(calc.lineAmount),
          new Prisma.Decimal(0),
        );
        const totalAmountUzs = computeAmountUzs(totalAmount, exchangeRate);
        const lineAmountsUzs = distributeLargestRemainder(
          itemCalcs.map((calc) => calc.lineAmount),
          totalAmountUzs,
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
            kind: PURCHASE_CREATE_KIND,
            idempotencyKey,
            requestHash,
            occurredAt,
            sequence,
          },
        });

        // Step 4 — create Purchase + immutable PurchaseItem rows.
        const purchase = await tx.purchase.create({
          data: {
            projectId,
            operationId: operation.id,
            supplierId: supplier.id,
            supplierNameSnapshot: supplier.name,
            warehouseId: warehouse.id,
            warehouseNameSnapshot: warehouse.name,
            currency: dto.currency,
            exchangeRate,
            rateSource,
            rateId,
            rateOverrideReason,
            totalAmount,
            totalAmountUzs,
            invoiceNumber: dto.invoiceNumber ?? null,
            comment: dto.comment ?? null,
            occurredAt,
            createdById: user.id,
          },
        });

        // Step 5 — one PURCHASE_RECEIPT movement per distinct material,
        // applying the weighted-average receipt formula and updating
        // InventoryBalance under the already-held project lock.
        const createdItems: ((typeof itemCalcs)[number] & {
          id: string;
          lineNumber: number;
          lineAmountUzs: Prisma.Decimal;
        })[] = [];
        for (let index = 0; index < itemCalcs.length; index += 1) {
          const calc = itemCalcs[index];
          const lineNumber = index + 1;
          const lineAmountUzs = lineAmountsUzs[index];

          const purchaseItem = await tx.purchaseItem.create({
            data: {
              purchaseId: purchase.id,
              lineNumber,
              materialId: calc.material.id,
              materialNameSnapshot: calc.material.name,
              quantity: calc.quantity,
              unitPrice: calc.unitPrice,
              lineAmount: calc.lineAmount,
              lineAmountUzs,
            },
          });
          createdItems.push({
            ...calc,
            id: purchaseItem.id,
            lineNumber,
            lineAmountUzs,
          });

          const existingBalance = await tx.inventoryBalance.findUnique({
            where: {
              warehouseId_materialId: {
                warehouseId: warehouse.id,
                materialId: calc.material.id,
              },
            },
          });
          const currentPosition = existingBalance
            ? {
                quantity: existingBalance.quantity,
                valueUzs: existingBalance.valueUzs,
              }
            : {
                quantity: new Prisma.Decimal(0),
                valueUzs: new Prisma.Decimal(0),
              };
          const { result, unitCostUzs } = receiveStockByValue(
            currentPosition,
            calc.quantity,
            lineAmountUzs,
          );
          if (existingBalance) {
            await tx.inventoryBalance.update({
              where: { id: existingBalance.id },
              data: { quantity: result.quantity, valueUzs: result.valueUzs },
            });
          } else {
            await tx.inventoryBalance.create({
              data: {
                projectId,
                warehouseId: warehouse.id,
                materialId: calc.material.id,
                quantity: result.quantity,
                valueUzs: result.valueUzs,
              },
            });
          }

          await tx.stockMovement.create({
            data: {
              projectId,
              operationId: operation.id,
              purchaseItemId: purchaseItem.id,
              warehouseId: warehouse.id,
              materialId: calc.material.id,
              type: StockMovementType.PURCHASE_RECEIPT,
              direction: TransactionDirection.IN,
              quantity: calc.quantity,
              unitCostUzs,
              totalCostUzs: lineAmountUzs,
              occurredAt,
              createdById: user.id,
            },
          });
        }

        // Steps 6-8 — settlement: advances first, then an optional cash
        // payment, tracking the running settled total in the purchase's own
        // currency so it can never exceed the invoice total.
        let settledSoFar = new Prisma.Decimal(0);
        const auditableAllocations: { id: string; kind: string }[] = [];

        for (const allocationInput of advanceAllocationInputs) {
          const advance = advancesById.get(allocationInput.advanceId)!;
          const settlementAmount = new Prisma.Decimal(allocationInput.amount);

          const consumedGrouped = await tx.settlementAllocation.groupBy({
            by: ['effect'],
            where: { advanceId: advance.id },
            _sum: { settlementAmount: true },
          });
          let applied = new Prisma.Decimal(0);
          let reversed = new Prisma.Decimal(0);
          for (const row of consumedGrouped) {
            if (row.effect === SettlementEffect.APPLY) {
              applied = row._sum.settlementAmount ?? applied;
            } else {
              reversed = row._sum.settlementAmount ?? reversed;
            }
          }
          const available = advance.fundedAmount.minus(applied).plus(reversed);
          if (settlementAmount.greaterThan(available)) {
            throw new ConflictException({
              code: 'ADVANCE_EXCEEDS_AVAILABLE',
              message: `Requested ${settlementAmount.toFixed(2)} ${advance.currency} but only ${available.toFixed(2)} is available on this advance`,
            });
          }

          const settlementValueUzs =
            advance.currency === Currency.UZS
              ? settlementAmount
              : round2(
                  settlementAmount.mul(
                    advance.fundedAmountUzs.dividedBy(advance.fundedAmount),
                  ),
                );

          let debtAmountSettled: Prisma.Decimal;
          let settlementExchangeRate: Prisma.Decimal | null;
          try {
            ({ debtAmountSettled, settlementExchangeRate } =
              resolveSettlementCase({
                settlementCurrency: advance.currency,
                settlementAmount,
                settlementValueUzs,
                debtCurrency: dto.currency,
                providedSettlementExchangeRate:
                  allocationInput.settlementExchangeRate
                    ? new Prisma.Decimal(allocationInput.settlementExchangeRate)
                    : undefined,
              }));
          } catch (error) {
            if (error instanceof SettlementRateRequiredError) {
              throw new ConflictException({
                code: 'SETTLEMENT_RATE_REQUIRED',
                message: error.message,
              });
            }
            throw error;
          }

          settledSoFar = settledSoFar.plus(debtAmountSettled);
          if (settledSoFar.greaterThan(totalAmount)) {
            throw new ConflictException({
              code: 'DEBT_PAYMENT_EXCEEDS_REMAINING',
              message: `Settlement would exceed the purchase's total of ${totalAmount.toFixed(2)} ${dto.currency}`,
            });
          }

          const purchaseExchangeRateAtInvoice =
            dto.currency === Currency.UZS
              ? new Prisma.Decimal(1)
              : exchangeRate;
          const exchangeDifferenceUzs = computeExchangeDifferenceUzs(
            settlementValueUzs,
            debtAmountSettled,
            purchaseExchangeRateAtInvoice,
          );

          const allocation = await tx.settlementAllocation.create({
            data: {
              projectId,
              operationId: operation.id,
              supplierId: supplier.id,
              purchaseId: purchase.id,
              advanceId: advance.id,
              settlementCurrency: advance.currency,
              settlementAmount,
              settlementValueUzs,
              debtCurrency: dto.currency,
              settlementExchangeRate,
              debtAmountSettled,
              exchangeDifferenceUzs,
              effect: SettlementEffect.APPLY,
              createdById: user.id,
            },
          });
          auditableAllocations.push({
            id: allocation.id,
            kind: 'advance_consumption',
          });
        }

        const cashPaid = dto.cashPaid
          ? new Prisma.Decimal(dto.cashPaid)
          : new Prisma.Decimal(0);
        if (cashPaid.greaterThan(0)) {
          // cashPaid is always in the purchase's own currency (this DTO's
          // documented Phase 7 scope decision) — always settlement case 1,
          // no cross-currency confusion at purchase-creation time.
          const settlementValueUzs = computeAmountUzs(cashPaid, exchangeRate);
          settledSoFar = settledSoFar.plus(cashPaid);
          if (settledSoFar.greaterThan(totalAmount)) {
            throw new ConflictException({
              code: 'DEBT_PAYMENT_EXCEEDS_REMAINING',
              message: `Cash payment would exceed the purchase's total of ${totalAmount.toFixed(2)} ${dto.currency}`,
            });
          }

          const payment = await tx.supplierPayment.create({
            data: {
              projectId,
              operationId: operation.id,
              supplierId: supplier.id,
              purpose: 'PURCHASE_CASH',
              currency: dto.currency,
              amount: cashPaid,
              exchangeRate,
              amountUzs: settlementValueUzs,
              rateSource,
              rateId,
              rateOverrideReason,
              comment: dto.comment ?? null,
              createdById: user.id,
            },
          });

          await this.financialPosting.postCashEffect(tx, {
            projectId,
            operationId: operation.id,
            type: FinancialTransactionType.PURCHASE,
            amount: cashPaid,
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
              supplierId: supplier.id,
              purchaseId: purchase.id,
              fundingPaymentId: payment.id,
              settlementCurrency: dto.currency,
              settlementAmount: cashPaid,
              settlementValueUzs,
              debtCurrency: dto.currency,
              settlementExchangeRate: null,
              debtAmountSettled: cashPaid,
              exchangeDifferenceUzs: new Prisma.Decimal(0),
              effect: SettlementEffect.APPLY,
              createdById: user.id,
            },
          });
          auditableAllocations.push({
            id: allocation.id,
            kind: 'cash_payment',
          });
        }

        // Step 8 (final invariant re-check, defense-in-depth — every path
        // above already enforces this incrementally).
        if (settledSoFar.greaterThan(totalAmount)) {
          throw new ConflictException({
            code: 'DEBT_PAYMENT_EXCEEDS_REMAINING',
            message: 'Total settlement exceeds the purchase total',
          });
        }

        const fullPurchase = await tx.purchase.findUniqueOrThrow({
          where: { id: purchase.id },
          include: { items: { orderBy: { lineNumber: 'asc' } } },
        });
        const response = await this.toResponse(tx, fullPurchase);

        // Step 9 — audit: the purchase itself, then each settlement effect
        // it produced (transaction-design.md §4 step 9 / specification §31).
        await this.audit.record(tx, {
          projectId,
          actorId: user.id,
          action: PURCHASE_CREATE_KIND,
          entityType: 'Purchase',
          entityId: purchase.id,
          operationId: operation.id,
          requestId,
          newData: { ...response },
        });
        for (const { id, kind } of auditableAllocations) {
          const allocation = await tx.settlementAllocation.findUniqueOrThrow({
            where: { id },
          });
          await this.audit.record(tx, {
            projectId,
            actorId: user.id,
            action: `purchase.${kind}`,
            entityType: 'SettlementAllocation',
            entityId: id,
            operationId: operation.id,
            requestId,
            newData: { ...this.toAllocationSnapshot(allocation) },
          });
        }

        return { purchase: response, isReplay: false };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existingOperation =
          await this.prisma.client.postedOperation.findUnique({
            where: {
              projectId_actorId_kind_idempotencyKey: {
                projectId,
                actorId: user.id,
                kind: PURCHASE_CREATE_KIND,
                idempotencyKey,
              },
            },
          });
        if (
          existingOperation &&
          existingOperation.requestHash === requestHash
        ) {
          const existing = await this.prisma.client.purchase.findUnique({
            where: { operationId: existingOperation.id },
            include: { items: { orderBy: { lineNumber: 'asc' } } },
          });
          if (existing) {
            return {
              purchase: await this.toResponse(this.prisma.client, existing),
              isReplay: true,
            };
          }
        }
      }
      throw error;
    }
  }

  async list(
    user: AuthenticatedUser,
    projectId: string,
    query: ListPurchasesQueryDto,
  ): Promise<PaginatedPurchasesResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );

    const where: Prisma.PurchaseWhereInput = { projectId };
    if (!query.includeCancelled) {
      where.cancelledAt = null;
    }
    if (query.supplierId) {
      where.supplierId = query.supplierId;
    }
    if (query.warehouseId) {
      where.warehouseId = query.warehouseId;
    }
    if (query.dateFrom || query.dateTo) {
      where.occurredAt = {
        ...(query.dateFrom
          ? { gte: new Date(`${query.dateFrom}T00:00:00.000Z`) }
          : {}),
        ...(query.dateTo
          ? { lt: new Date(`${query.dateTo}T00:00:00.000Z`) }
          : {}),
      };
    }

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const [rows, total] = await Promise.all([
      this.prisma.client.purchase.findMany({
        where,
        include: { items: { orderBy: { lineNumber: 'asc' } } },
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.client.purchase.count({ where }),
    ]);

    const data = await Promise.all(
      rows.map((row) => this.toResponse(this.prisma.client, row)),
    );
    return { data, total, page, pageSize };
  }

  async get(
    user: AuthenticatedUser,
    projectId: string,
    purchaseId: string,
  ): Promise<PurchaseResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    const purchase = await this.getPurchaseOrThrow(projectId, purchaseId);
    return this.toResponse(this.prisma.client, purchase);
  }

  /** `PATCH P/purchases/:id` — comment only, matching every other posted
   * workflow's row (docs/backend-architecture.md's route table). No project
   * lock, no idempotency key: this never touches inventory, cash, or debt. */
  async editComment(
    user: AuthenticatedUser,
    projectId: string,
    purchaseId: string,
    dto: EditCommentDto,
    requestId?: string,
  ): Promise<PurchaseResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.WRITE,
    );
    const existing = await this.getPurchaseOrThrow(projectId, purchaseId);

    const updated = await this.prisma.client.$transaction(async (tx) => {
      const row = await tx.purchase.update({
        where: { id: purchaseId },
        data: { comment: dto.comment },
        include: { items: { orderBy: { lineNumber: 'asc' } } },
      });
      await this.audit.record(tx, {
        projectId,
        actorId: user.id,
        action: 'purchase.comment_edit',
        entityType: 'Purchase',
        entityId: row.id,
        operationId: row.operationId,
        requestId,
        previousData: { ...(await this.toResponse(tx, existing)) },
        newData: { ...(await this.toResponse(tx, row)) },
      });
      return row;
    });

    return this.toResponse(this.prisma.client, updated);
  }

  /**
   * Dependency-checked cancellation (transaction-design.md §8). Rejects
   * with `409 PURCHASE_HAS_DEPENDENT_MOVEMENTS` if any LATER operation
   * (a subsequent purchase/write-off/transfer touching the same
   * warehouse+material, or a separate debt-payment/advance-consumption
   * against this purchase) has built on top of this purchase's effect —
   * detected here via `PostedOperation.sequence` ordering rather than a
   * dedicated effective-head pointer (Phase 0's fuller design, deferred;
   * see this phase's own report). Otherwise reverses, in the same
   * transaction: every StockMovement/InventoryBalance change and every
   * SettlementAllocation (and its linked cash effect, if any) this
   * purchase's OWN operation created.
   */
  async cancel(
    user: AuthenticatedUser,
    projectId: string,
    purchaseId: string,
    dto: CancelPurchaseDto,
    idempotencyKey: string,
    requestId?: string,
  ): Promise<CancelPurchaseResult> {
    const requestHash = computeRequestHash({
      kind: PURCHASE_CANCEL_KIND,
      projectId,
      purchaseId,
      reason: dto.reason,
    });

    try {
      return await this.projectLock.runExclusive(projectId, async (tx) => {
        await this.projectAccess.assertAccessInTransaction(
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
              kind: PURCHASE_CANCEL_KIND,
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
          if (!existingOperation.reversalOfId) {
            throw new NotFoundException({
              code: 'NOT_FOUND',
              message: 'Replayed cancellation not found',
            });
          }
          const original = await tx.purchase.findFirst({
            where: { operationId: existingOperation.reversalOfId, projectId },
            include: { items: { orderBy: { lineNumber: 'asc' } } },
          });
          if (!original) {
            throw new NotFoundException({
              code: 'NOT_FOUND',
              message: 'Replayed cancellation not found',
            });
          }
          return {
            purchase: await this.toResponse(tx, original),
            isReplay: true,
          };
        }

        const purchase = await tx.purchase.findFirst({
          where: { id: purchaseId, projectId },
          include: { items: { orderBy: { lineNumber: 'asc' } } },
        });
        if (!purchase) {
          throw new NotFoundException({
            code: 'NOT_FOUND',
            message: 'Purchase not found in this project',
          });
        }
        if (purchase.cancelledAt) {
          throw new ConflictException({
            code: 'PURCHASE_ALREADY_CANCELLED',
            message: 'This purchase has already been cancelled',
          });
        }

        const purchaseOperation = await tx.postedOperation.findUniqueOrThrow({
          where: { id: purchase.operationId },
        });
        const reversedOperationIds = await loadReversedOperationIds(
          tx,
          projectId,
        );

        // Dependency check A (inventory): any STILL-EFFECTIVE StockMovement
        // for the same warehouse+material, posted by a strictly later
        // operation, means this purchase's receipt is no longer the
        // balance's most recent contribution — checked per distinct
        // material this purchase touched.
        const materialIds = [
          ...new Set(purchase.items.map((item) => item.materialId)),
        ];
        let hasLaterMovement = false;
        for (const materialId of materialIds) {
          if (
            await hasLaterEffectiveMovement(tx, {
              projectId,
              warehouseId: purchase.warehouseId,
              materialId,
              afterSequence: purchaseOperation.sequence,
              reversedOperationIds,
            })
          ) {
            hasLaterMovement = true;
            break;
          }
        }
        if (hasLaterMovement) {
          throw new ConflictException({
            code: 'PURCHASE_HAS_DEPENDENT_MOVEMENTS',
            message:
              "A later inventory movement depends on this purchase's receipt; it cannot be cancelled",
          });
        }

        // Dependency check B (settlement): any STILL-EFFECTIVE
        // SettlementAllocation against this purchase from a SEPARATE, later
        // operation (a debt payment or advance consumption posted
        // afterward) must be reversed first — there is no such reversal
        // endpoint yet, so this is a hard block.
        const laterAllocationCandidates =
          await tx.settlementAllocation.findMany({
            where: {
              projectId,
              purchaseId: purchase.id,
              effect: SettlementEffect.APPLY,
              operationId: { not: purchase.operationId },
            },
            select: { operationId: true },
          });
        const hasLaterAllocation = laterAllocationCandidates.some(
          (allocation) => !reversedOperationIds.has(allocation.operationId),
        );
        if (hasLaterAllocation) {
          throw new ConflictException({
            code: 'PURCHASE_HAS_DEPENDENT_MOVEMENTS',
            message:
              'A later payment or advance consumption depends on this purchase; it cannot be cancelled',
          });
        }

        // Captured now, before any reversal row is written — `toResponse`
        // re-derives `remainingDebt`/`status` from a fresh read every time,
        // so calling it again after the reversal writes below would show
        // the ALREADY-reversed state for what is supposed to be the audit
        // entry's "previous" snapshot.
        const previousResponse = await this.toResponse(tx, purchase);

        const sequence = await this.projectLock.bumpPostingSequence(
          tx,
          projectId,
        );
        const reversalOperation = await tx.postedOperation.create({
          data: {
            projectId,
            actorId: user.id,
            kind: PURCHASE_CANCEL_KIND,
            idempotencyKey,
            requestHash,
            occurredAt: purchase.occurredAt,
            sequence,
            reversalOfId: purchase.operationId,
          },
        });

        // Reverse this purchase's own receipts.
        const originalMovements = await tx.stockMovement.findMany({
          where: { projectId, operationId: purchase.operationId },
        });
        for (const movement of originalMovements) {
          const balance = await tx.inventoryBalance.findUniqueOrThrow({
            where: {
              warehouseId_materialId: {
                warehouseId: movement.warehouseId,
                materialId: movement.materialId,
              },
            },
          });
          // The dependency check above guarantees nothing has touched this
          // balance since this purchase's own receipt — so if the receipt
          // is the entirety of the current balance, its pre-purchase state
          // was exactly zero; hardcode that rather than trust subtraction
          // to land on it exactly (the same discipline as `depleteStock`'s
          // full-depletion branch).
          const isEntireBalance = balance.quantity.equals(movement.quantity);
          const restoredQuantity = isEntireBalance
            ? new Prisma.Decimal(0)
            : balance.quantity.minus(movement.quantity);
          const restoredValueUzs = isEntireBalance
            ? new Prisma.Decimal(0)
            : balance.valueUzs.minus(movement.totalCostUzs);

          await tx.inventoryBalance.update({
            where: { id: balance.id },
            data: { quantity: restoredQuantity, valueUzs: restoredValueUzs },
          });
          await tx.stockMovement.create({
            data: {
              projectId,
              operationId: reversalOperation.id,
              purchaseItemId: movement.purchaseItemId,
              warehouseId: movement.warehouseId,
              materialId: movement.materialId,
              type: StockMovementType.REVERSAL,
              direction: TransactionDirection.OUT,
              quantity: movement.quantity,
              unitCostUzs: movement.unitCostUzs,
              totalCostUzs: movement.totalCostUzs,
              occurredAt: purchase.occurredAt,
              createdById: user.id,
            },
          });
        }

        // Reverse this purchase's own settlement allocations (advance
        // consumption and/or the cash-payment allocation), and the cash
        // effect underneath the latter, if any.
        const originalAllocations = await tx.settlementAllocation.findMany({
          where: { projectId, operationId: purchase.operationId },
        });
        const reversedAllocationIds: string[] = [];
        for (const allocation of originalAllocations) {
          const reversal = await tx.settlementAllocation.create({
            data: {
              projectId,
              operationId: reversalOperation.id,
              supplierId: allocation.supplierId,
              purchaseId: allocation.purchaseId,
              advanceId: allocation.advanceId,
              fundingPaymentId: allocation.fundingPaymentId,
              settlementCurrency: allocation.settlementCurrency,
              settlementAmount: allocation.settlementAmount,
              settlementValueUzs: allocation.settlementValueUzs,
              debtCurrency: allocation.debtCurrency,
              settlementExchangeRate: allocation.settlementExchangeRate,
              debtAmountSettled: allocation.debtAmountSettled,
              exchangeDifferenceUzs: allocation.exchangeDifferenceUzs,
              effect: SettlementEffect.REVERSE,
              createdById: user.id,
              reversalOfId: allocation.id,
            },
          });
          reversedAllocationIds.push(reversal.id);

          if (allocation.fundingPaymentId) {
            await this.financialPosting.reverseCashEffectForSupplierPayment(
              tx,
              {
                projectId,
                reversalOperationId: reversalOperation.id,
                supplierPaymentId: allocation.fundingPaymentId,
                cancellationReason: `Reversed: purchase cancelled — ${dto.reason}`,
                createdById: user.id,
              },
            );
          }
        }

        const cancelledPurchase = await tx.purchase.update({
          where: { id: purchase.id },
          data: {
            cancelledAt: new Date(),
            cancellationReason: dto.reason,
            cancelledById: user.id,
          },
          include: { items: { orderBy: { lineNumber: 'asc' } } },
        });

        const response = await this.toResponse(tx, cancelledPurchase);
        await this.audit.record(tx, {
          projectId,
          actorId: user.id,
          action: PURCHASE_CANCEL_KIND,
          entityType: 'Purchase',
          entityId: purchase.id,
          operationId: reversalOperation.id,
          requestId,
          previousData: { ...previousResponse },
          newData: { ...response },
        });
        for (const id of reversedAllocationIds) {
          const reversal = await tx.settlementAllocation.findUniqueOrThrow({
            where: { id },
          });
          await this.audit.record(tx, {
            projectId,
            actorId: user.id,
            action: 'purchase.settlement_reversed',
            entityType: 'SettlementAllocation',
            entityId: id,
            operationId: reversalOperation.id,
            requestId,
            newData: { ...this.toAllocationSnapshot(reversal) },
          });
        }

        return { purchase: response, isReplay: false };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existingOperation =
          await this.prisma.client.postedOperation.findUnique({
            where: {
              projectId_actorId_kind_idempotencyKey: {
                projectId,
                actorId: user.id,
                kind: PURCHASE_CANCEL_KIND,
                idempotencyKey,
              },
            },
          });
        if (
          existingOperation &&
          existingOperation.requestHash === requestHash &&
          existingOperation.reversalOfId
        ) {
          const original = await this.prisma.client.purchase.findFirst({
            where: { operationId: existingOperation.reversalOfId, projectId },
            include: { items: { orderBy: { lineNumber: 'asc' } } },
          });
          if (original) {
            return {
              purchase: await this.toResponse(this.prisma.client, original),
              isReplay: true,
            };
          }
        }
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------

  private async getPurchaseOrThrow(
    projectId: string,
    purchaseId: string,
  ): Promise<PurchaseWithItems> {
    const purchase = await this.prisma.client.purchase.findFirst({
      where: { id: purchaseId, projectId },
      include: { items: { orderBy: { lineNumber: 'asc' } } },
    });
    if (!purchase) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Purchase not found in this project',
      });
    }
    return purchase;
  }

  /** Status is always derived, never persisted (this phase's own §7.8) — a
   * fresh read of effective settlement allocations, the same primitive
   * `DebtPaymentsService` uses. */
  private async toResponse(
    client: PrismaTx | PrismaService['client'],
    purchase: PurchaseWithItems,
  ): Promise<PurchaseResponseDto> {
    const remainingDebt = purchase.cancelledAt
      ? new Prisma.Decimal(0)
      : await computeRemainingDebt(client, purchase.id, purchase.totalAmount);

    let status: PurchaseStatus;
    if (purchase.cancelledAt) {
      status = PurchaseStatus.CANCELLED;
    } else if (remainingDebt.equals(purchase.totalAmount)) {
      status = PurchaseStatus.UNPAID;
    } else if (remainingDebt.isZero()) {
      status = PurchaseStatus.PAID;
    } else {
      status = PurchaseStatus.PARTIALLY_PAID;
    }

    return {
      id: purchase.id,
      projectId: purchase.projectId,
      supplierId: purchase.supplierId,
      supplierNameSnapshot: purchase.supplierNameSnapshot,
      warehouseId: purchase.warehouseId,
      warehouseNameSnapshot: purchase.warehouseNameSnapshot,
      currency: purchase.currency,
      exchangeRate: purchase.exchangeRate.toFixed(8),
      rateSource: purchase.rateSource,
      rateId: purchase.rateId,
      rateOverrideReason: purchase.rateOverrideReason,
      totalAmount: purchase.totalAmount.toFixed(2),
      totalAmountUzs: purchase.totalAmountUzs.toFixed(2),
      remainingDebt: remainingDebt.toFixed(2),
      status,
      invoiceNumber: purchase.invoiceNumber,
      comment: purchase.comment,
      occurredAt: purchase.occurredAt.toISOString().slice(0, 10),
      createdById: purchase.createdById,
      createdAt: purchase.createdAt,
      cancelledAt: purchase.cancelledAt,
      cancellationReason: purchase.cancellationReason,
      cancelledById: purchase.cancelledById,
      items: purchase.items
        .slice()
        .sort((a, b) => a.lineNumber - b.lineNumber)
        .map((item): PurchaseItemResponseDto => ({
          id: item.id,
          lineNumber: item.lineNumber,
          materialId: item.materialId,
          materialNameSnapshot: item.materialNameSnapshot,
          quantity: item.quantity.toFixed(6),
          unitPrice: item.unitPrice.toFixed(8),
          lineAmount: item.lineAmount.toFixed(2),
          lineAmountUzs: item.lineAmountUzs.toFixed(2),
        })),
    };
  }

  private toAllocationSnapshot(
    allocation: Prisma.SettlementAllocationGetPayload<object>,
  ): Record<string, unknown> {
    return {
      id: allocation.id,
      purchaseId: allocation.purchaseId,
      advanceId: allocation.advanceId,
      fundingPaymentId: allocation.fundingPaymentId,
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
      reversalOfId: allocation.reversalOfId,
    };
  }
}
