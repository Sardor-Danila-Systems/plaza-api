import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { computeRequestHash } from '../../common/idempotency/request-hash.util.js';
import { isFutureBusinessDate } from '../../common/date/business-date.util.js';
import { computeAmountUzs } from '../../common/money/decimal.util.js';
import {
  PrismaTx,
  ProjectLockService,
} from '../../database/project-lock.service.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  Currency,
  FinancialTransaction,
  FinancialTransactionType,
  Prisma,
  RateSource,
  TransactionCategoryKind,
  TransactionDirection,
} from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { ProjectAccessAction } from '../projects/project-access-action.enum.js';
import { ProjectAccessService } from '../projects/project-access.service.js';
import { CancelFinancialTransactionDto } from './dto/cancel-financial-transaction.dto.js';
import { CreateFinancialTransactionDto } from './dto/create-financial-transaction.dto.js';
import { EditCommentDto } from './dto/edit-comment.dto.js';
import { FinancialTransactionResponseDto } from './dto/financial-transaction-response.dto.js';
import { ListFinancialTransactionsQueryDto } from './dto/list-financial-transactions-query.dto.js';
import { PaginatedFinancialTransactionsResponseDto } from './dto/paginated-financial-transactions-response.dto.js';
import { BalanceResponseDto } from './dto/balance-response.dto.js';

const CREATE_OPERATION_KIND = 'financial_transaction.create';
const CANCEL_OPERATION_KIND = 'financial_transaction.cancel';

function directionForType(
  type: FinancialTransactionType,
): TransactionDirection {
  switch (type) {
    case FinancialTransactionType.INCOME:
    case FinancialTransactionType.REFUND:
      return TransactionDirection.IN;
    case FinancialTransactionType.EXPENSE:
    case FinancialTransactionType.SALARY:
    case FinancialTransactionType.PURCHASE:
    case FinancialTransactionType.ADVANCE:
    case FinancialTransactionType.DEBT_PAYMENT:
      return TransactionDirection.OUT;
    case FinancialTransactionType.ADJUSTMENT:
      // No posting path creates ADJUSTMENT rows yet (opening-balance
      // workflow deferred, per this phase's report) — reaching this is a
      // programming error, not a request the DTO layer can produce.
      throw new Error(
        'ADJUSTMENT has no fixed direction and no posting path yet',
      );
  }
}

export interface CreateFinancialTransactionResult {
  transaction: FinancialTransactionResponseDto;
  /** true if this call returned a previously committed result rather than
   * creating a new one (docs/transaction-design.md §3) — the controller
   * uses this to answer 200 instead of 201. */
  isReplay: boolean;
}

export interface CancelFinancialTransactionResult {
  transaction: FinancialTransactionResponseDto;
  isReplay: boolean;
}

/**
 * `FinancialPostingService` per docs/backend-architecture.md §6's module
 * interface table: "Allowed cash kinds, balance checks, immutable monetary
 * fields, audit." Owns the complete posting/cancellation transaction —
 * project lock, idempotency, validation, the ledger write, and the audit
 * insert all happen here, inside one transaction (§6: "Workflow services
 * own a complete business transaction").
 */
@Injectable()
export class FinancialPostingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly projectLock: ProjectLockService,
    private readonly audit: AuditService,
  ) {}

  async create(
    user: AuthenticatedUser,
    projectId: string,
    dto: CreateFinancialTransactionDto,
    idempotencyKey: string,
    requestId?: string,
  ): Promise<CreateFinancialTransactionResult> {
    const requestHash = computeRequestHash({
      kind: CREATE_OPERATION_KIND,
      projectId,
      type: dto.type,
      amount: dto.amount,
      currency: dto.currency,
      exchangeRate: dto.exchangeRate,
      currencyRateId: dto.currencyRateId,
      rateOverrideReason: dto.rateOverrideReason,
      categoryId: dto.categoryId,
      source: dto.source,
      recipient: dto.recipient,
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

        const replay = await this.findIdempotentReplay(
          tx,
          projectId,
          user.id,
          CREATE_OPERATION_KIND,
          idempotencyKey,
          requestHash,
        );
        if (replay) {
          return { transaction: replay, isReplay: true };
        }

        if (isFutureBusinessDate(dto.occurredAt, project.timezone)) {
          throw new BadRequestException({
            code: 'VALIDATION_ERROR',
            message: 'occurredAt cannot be a future business date',
          });
        }

        const category = await this.resolveCategory(
          tx,
          projectId,
          dto.type,
          dto.categoryId,
        );
        const { exchangeRate, rateId, rateOverrideReason, rateSource } =
          await this.resolveRate(tx, projectId, dto.currency, dto);
        const amount = new Prisma.Decimal(dto.amount);
        const amountUzs = computeAmountUzs(amount, exchangeRate);
        const direction = directionForType(dto.type);

        if (direction === TransactionDirection.OUT) {
          await this.assertSufficientBalance(
            tx,
            projectId,
            dto.currency,
            amount,
          );
        }

        const sequence = await this.projectLock.bumpPostingSequence(
          tx,
          projectId,
        );
        const operation = await tx.postedOperation.create({
          data: {
            projectId,
            actorId: user.id,
            kind: CREATE_OPERATION_KIND,
            idempotencyKey,
            requestHash,
            occurredAt: new Date(`${dto.occurredAt}T00:00:00.000Z`),
            sequence,
          },
        });

        const recipient =
          dto.type === FinancialTransactionType.INCOME
            ? dto.source
            : dto.recipient;

        const created = await tx.financialTransaction.create({
          data: {
            projectId,
            operationId: operation.id,
            type: dto.type,
            direction,
            amount,
            currency: dto.currency,
            exchangeRate,
            amountUzs,
            rateSource,
            rateId,
            rateOverrideReason,
            categoryId: category?.id ?? null,
            categoryNameSnapshot: category?.name ?? null,
            recipient: recipient ?? null,
            comment: dto.comment ?? null,
            occurredAt: new Date(`${dto.occurredAt}T00:00:00.000Z`),
            createdById: user.id,
          },
        });

        const response = this.toResponse(created);
        await this.audit.record(tx, {
          projectId,
          actorId: user.id,
          action: CREATE_OPERATION_KIND,
          entityType: 'FinancialTransaction',
          entityId: created.id,
          operationId: operation.id,
          requestId,
          newData: { ...response },
        });

        return { transaction: response, isReplay: false };
      });
    } catch (error) {
      const idempotentRace = await this.recoverFromIdempotencyRace(
        error,
        projectId,
        user.id,
        CREATE_OPERATION_KIND,
        idempotencyKey,
        requestHash,
      );
      if (idempotentRace) {
        return { transaction: idempotentRace, isReplay: true };
      }
      throw error;
    }
  }

  async list(
    user: AuthenticatedUser,
    projectId: string,
    query: ListFinancialTransactionsQueryDto,
  ): Promise<PaginatedFinancialTransactionsResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );

    const where: Prisma.FinancialTransactionWhereInput = { projectId };
    if (!query.includeCancelled) {
      where.cancelledAt = null;
    }
    if (query.type) {
      where.type = query.type;
    }
    if (query.categoryId) {
      where.categoryId = query.categoryId;
    }
    if (query.currency) {
      where.currency = query.currency;
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
      this.prisma.client.financialTransaction.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.client.financialTransaction.count({ where }),
    ]);

    return {
      data: rows.map((row) => this.toResponse(row)),
      total,
      page,
      pageSize,
    };
  }

  async get(
    user: AuthenticatedUser,
    projectId: string,
    transactionId: string,
  ): Promise<FinancialTransactionResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    const transaction = await this.getTransactionOrThrow(
      projectId,
      transactionId,
    );
    return this.toResponse(transaction);
  }

  async getBalance(
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<BalanceResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    const uzs = await this.computeBalance(
      this.prisma.client,
      projectId,
      Currency.UZS,
    );
    const usd = await this.computeBalance(
      this.prisma.client,
      projectId,
      Currency.USD,
    );
    return { uzs: uzs.toFixed(2), usd: usd.toFixed(2) };
  }

  /**
   * `PATCH P/finances/:id` — comment only (docs/backend-architecture.md's
   * route table). No project lock, no idempotency key: this never touches
   * the ledger (amount/direction/currency are untouched), so it carries
   * none of the concurrency risk the posting/cancellation workflows do.
   */
  async editComment(
    user: AuthenticatedUser,
    projectId: string,
    transactionId: string,
    dto: EditCommentDto,
    requestId?: string,
  ): Promise<FinancialTransactionResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.WRITE,
    );
    const existing = await this.getTransactionOrThrow(projectId, transactionId);

    const updated = await this.prisma.client.$transaction(async (tx) => {
      const row = await tx.financialTransaction.update({
        where: { id: transactionId },
        data: { comment: dto.comment },
      });
      await this.audit.record(tx, {
        projectId,
        actorId: user.id,
        action: 'financial_transaction.comment_edit',
        entityType: 'FinancialTransaction',
        entityId: row.id,
        operationId: row.operationId,
        requestId,
        previousData: { ...this.toResponse(existing) },
        newData: { ...this.toResponse(row) },
      });
      return row;
    });

    return this.toResponse(updated);
  }

  async cancel(
    user: AuthenticatedUser,
    projectId: string,
    transactionId: string,
    dto: CancelFinancialTransactionDto,
    idempotencyKey: string,
    requestId?: string,
  ): Promise<CancelFinancialTransactionResult> {
    const requestHash = computeRequestHash({
      kind: CANCEL_OPERATION_KIND,
      projectId,
      transactionId,
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

        const replay = await this.findIdempotentReplay(
          tx,
          projectId,
          user.id,
          CANCEL_OPERATION_KIND,
          idempotencyKey,
          requestHash,
        );
        if (replay) {
          return { transaction: replay, isReplay: true };
        }

        const original = await tx.financialTransaction.findFirst({
          where: { id: transactionId, projectId },
        });
        if (!original) {
          throw new NotFoundException({
            code: 'NOT_FOUND',
            message: 'Financial transaction not found in this project',
          });
        }
        if (original.cancelledAt) {
          throw new ConflictException({
            code: 'TRANSACTION_ALREADY_CANCELLED',
            message: 'This transaction has already been cancelled',
          });
        }
        if (original.reversalOfId) {
          throw new ConflictException({
            code: 'TRANSACTION_ALREADY_CANCELLED',
            message: 'A reversal transaction cannot itself be cancelled',
          });
        }

        const reversalDirection =
          original.direction === TransactionDirection.IN
            ? TransactionDirection.OUT
            : TransactionDirection.IN;

        // Reversing an IN-direction (e.g. INCOME) row removes money from the
        // project the same way any OUT posting does — it must not overdraw
        // the project (docs/backend-architecture.md's cancellation rules:
        // "Reversing income also checks nominal cash availability").
        if (reversalDirection === TransactionDirection.OUT) {
          await this.assertSufficientBalance(
            tx,
            projectId,
            original.currency,
            original.amount,
          );
        }

        const sequence = await this.projectLock.bumpPostingSequence(
          tx,
          projectId,
        );
        const reversalOperation = await tx.postedOperation.create({
          data: {
            projectId,
            actorId: user.id,
            kind: CANCEL_OPERATION_KIND,
            idempotencyKey,
            requestHash,
            occurredAt: original.occurredAt,
            sequence,
            reversalOfId: original.operationId,
          },
        });

        // Sequential, not `Promise.all`: one connection serves this
        // interactive transaction, so concurrent-looking calls would only
        // queue behind each other anyway, not actually run in parallel
        // (docs/backend-architecture.md §8) — sequential awaits say what
        // actually happens. Also avoids a redundant re-fetch: `update`
        // already returns the updated row.
        const cancelledAt = new Date();
        const cancelledOriginal = await tx.financialTransaction.update({
          where: { id: original.id },
          data: {
            cancelledAt,
            cancellationReason: dto.reason,
            cancelledById: user.id,
          },
        });
        const reversal = await tx.financialTransaction.create({
          data: {
            projectId,
            operationId: reversalOperation.id,
            type: original.type,
            direction: reversalDirection,
            amount: original.amount,
            currency: original.currency,
            exchangeRate: original.exchangeRate,
            amountUzs: original.amountUzs,
            rateSource: original.rateSource,
            rateId: original.rateId,
            rateOverrideReason: original.rateOverrideReason,
            categoryId: original.categoryId,
            categoryNameSnapshot: original.categoryNameSnapshot,
            recipient: original.recipient,
            comment: original.comment,
            occurredAt: original.occurredAt,
            createdById: user.id,
            reversalOfId: original.id,
          },
        });

        await this.audit.record(tx, {
          projectId,
          actorId: user.id,
          action: CANCEL_OPERATION_KIND,
          entityType: 'FinancialTransaction',
          entityId: original.id,
          operationId: reversalOperation.id,
          requestId,
          previousData: { ...this.toResponse(original) },
          newData: {
            original: this.toResponse(cancelledOriginal),
            reversal: this.toResponse(reversal),
          },
        });

        return {
          transaction: this.toResponse(cancelledOriginal),
          isReplay: false,
        };
      });
    } catch (error) {
      const idempotentRace = await this.recoverFromIdempotencyRace(
        error,
        projectId,
        user.id,
        CANCEL_OPERATION_KIND,
        idempotencyKey,
        requestHash,
      );
      if (idempotentRace) {
        return { transaction: idempotentRace, isReplay: true };
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------

  /**
   * `kind`-generic idempotent-replay lookup. For a CREATE, the operation's
   * effect is the row it created directly (`operationId` = this operation's
   * id). For a CANCEL, the operation's effect is recorded on the ORIGINAL
   * row (its `cancelledAt` fields), not the reversal row the cancel
   * operation created — reached via `reversalOfId`, which a cancel
   * operation always sets to the original operation's id.
   */
  private async findIdempotentReplay(
    tx: PrismaTx,
    projectId: string,
    actorId: string,
    kind: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<FinancialTransactionResponseDto | null> {
    const existingOperation = await tx.postedOperation.findUnique({
      where: {
        projectId_actorId_kind_idempotencyKey: {
          projectId,
          actorId,
          kind,
          idempotencyKey,
        },
      },
    });
    if (!existingOperation) {
      return null;
    }
    if (existingOperation.requestHash !== requestHash) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message:
          'This Idempotency-Key was already used with a different request payload',
      });
    }

    const effectOperationId =
      kind === CANCEL_OPERATION_KIND
        ? (existingOperation.reversalOfId ?? undefined)
        : existingOperation.id;
    if (!effectOperationId) {
      return null;
    }
    const transaction = await tx.financialTransaction.findFirst({
      where: { operationId: effectOperationId },
    });
    return transaction ? this.toResponse(transaction) : null;
  }

  /**
   * docs/transaction-design.md §3's documented race: two requests racing on
   * a fresh idempotency key both reach the unique insert; the loser hits a
   * unique-constraint violation instead of finding an existing row via the
   * earlier `findIdempotentReplay` check. Under this service's project-lock
   * protocol this should never actually be reachable (the lock fully
   * serializes same-project attempts — see `ProjectLockService`), but is
   * implemented anyway as the documented defense-in-depth rather than
   * assumed away.
   */
  private async recoverFromIdempotencyRace(
    error: unknown,
    projectId: string,
    actorId: string,
    kind: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<FinancialTransactionResponseDto | null> {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== 'P2002'
    ) {
      return null;
    }
    return this.findIdempotentReplay(
      this.prisma.client,
      projectId,
      actorId,
      kind,
      idempotencyKey,
      requestHash,
    );
  }

  private async resolveCategory(
    tx: PrismaTx,
    projectId: string,
    type: FinancialTransactionType,
    categoryId: string | undefined,
  ): Promise<{ id: string; name: string } | null> {
    if (!categoryId) {
      return null;
    }
    const category = await tx.transactionCategory.findFirst({
      where: { id: categoryId, projectId },
    });
    if (!category) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Transaction category not found in this project',
      });
    }
    if (!category.isActive) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'This transaction category is archived',
      });
    }
    const expectedKind =
      type === FinancialTransactionType.INCOME
        ? TransactionCategoryKind.INCOME
        : TransactionCategoryKind.EXPENSE;
    if (category.kind !== expectedKind) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `This category is ${category.kind}-kind and cannot be used for a ${type} transaction`,
      });
    }
    return { id: category.id, name: category.name };
  }

  private async resolveRate(
    tx: PrismaTx,
    projectId: string,
    currency: Currency,
    dto: CreateFinancialTransactionDto,
  ): Promise<{
    exchangeRate: Prisma.Decimal;
    rateId: string | null;
    rateOverrideReason: string | null;
    rateSource: RateSource;
  }> {
    if (currency === Currency.UZS) {
      return {
        exchangeRate: new Prisma.Decimal(1),
        rateId: null,
        rateOverrideReason: null,
        rateSource: RateSource.MANUAL,
      };
    }

    if (dto.currencyRateId) {
      const rate = await tx.currencyRate.findFirst({
        where: { id: dto.currencyRateId, projectId, currency: Currency.USD },
      });
      if (!rate) {
        throw new NotFoundException({
          code: 'NOT_FOUND',
          message: 'Currency rate not found in this project',
        });
      }
      return {
        exchangeRate: rate.rateUzs,
        rateId: rate.id,
        rateOverrideReason: null,
        rateSource: rate.source,
      };
    }

    // DTO-level `IsValidFinancialTransactionShape` already guarantees both
    // are present for a USD transaction without currencyRateId.
    return {
      exchangeRate: new Prisma.Decimal(dto.exchangeRate as string),
      rateId: null,
      rateOverrideReason: dto.rateOverrideReason as string,
      rateSource: RateSource.MANUAL,
    };
  }

  private async computeBalance(
    client: PrismaTx | PrismaService['client'],
    projectId: string,
    currency: Currency,
  ): Promise<Prisma.Decimal> {
    const grouped = await client.financialTransaction.groupBy({
      by: ['direction'],
      where: { projectId, currency },
      _sum: { amount: true },
    });
    let inSum = new Prisma.Decimal(0);
    let outSum = new Prisma.Decimal(0);
    for (const row of grouped) {
      if (row.direction === TransactionDirection.IN) {
        inSum = row._sum.amount ?? inSum;
      } else {
        outSum = row._sum.amount ?? outSum;
      }
    }
    return inSum.minus(outSum);
  }

  private async assertSufficientBalance(
    tx: PrismaTx,
    projectId: string,
    currency: Currency,
    amount: Prisma.Decimal,
  ): Promise<void> {
    const balance = await this.computeBalance(tx, projectId, currency);
    if (balance.lessThan(amount)) {
      throw new ConflictException({
        code: 'INSUFFICIENT_CASH',
        message: `Insufficient ${currency} balance: available ${balance.toFixed(2)}, requested ${amount.toFixed(2)}`,
      });
    }
  }

  private async getTransactionOrThrow(
    projectId: string,
    transactionId: string,
  ): Promise<FinancialTransaction> {
    const transaction = await this.prisma.client.financialTransaction.findFirst(
      {
        where: { id: transactionId, projectId },
      },
    );
    if (!transaction) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Financial transaction not found in this project',
      });
    }
    return transaction;
  }

  private toResponse(
    row: FinancialTransaction,
  ): FinancialTransactionResponseDto {
    return {
      id: row.id,
      projectId: row.projectId,
      operationId: row.operationId,
      type: row.type,
      direction: row.direction,
      amount: row.amount.toFixed(2),
      currency: row.currency,
      exchangeRate: row.exchangeRate.toFixed(8),
      amountUzs: row.amountUzs.toFixed(2),
      rateSource: row.rateSource,
      rateId: row.rateId,
      rateOverrideReason: row.rateOverrideReason,
      categoryId: row.categoryId,
      categoryNameSnapshot: row.categoryNameSnapshot,
      recipient: row.recipient,
      comment: row.comment,
      occurredAt: row.occurredAt.toISOString().slice(0, 10),
      createdById: row.createdById,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      cancelledAt: row.cancelledAt,
      cancellationReason: row.cancellationReason,
      cancelledById: row.cancelledById,
      reversalOfId: row.reversalOfId,
    };
  }
}
