import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isFutureBusinessDate } from '../../../common/date/business-date.util.js';
import { computeRequestHash } from '../../../common/idempotency/request-hash.util.js';
import {
  InsufficientStockError,
  depleteStock,
} from '../../../common/inventory/costing.util.js';
import {
  hasLaterEffectiveMovement,
  loadReversedOperationIds,
} from '../../../common/inventory/dependency-check.util.js';
import {
  PrismaTx,
  ProjectLockService,
} from '../../../database/project-lock.service.js';
import { PrismaService } from '../../../database/prisma.service.js';
import {
  Prisma,
  StockMovementType,
  TransactionDirection,
  WarehouseTransfer,
} from '../../../generated/prisma/client.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { ProjectAccessAction } from '../../projects/project-access-action.enum.js';
import { ProjectAccessService } from '../../projects/project-access.service.js';
import { CancelTransferDto } from './dto/cancel-transfer.dto.js';
import { CreateTransferDto } from './dto/create-transfer.dto.js';
import { ListTransfersQueryDto } from './dto/list-transfers-query.dto.js';
import { PaginatedTransfersResponseDto } from './dto/paginated-transfers-response.dto.js';
import { TransferResponseDto } from './dto/transfer-response.dto.js';

const TRANSFER_CREATE_KIND = 'warehouse_transfer.create';
const TRANSFER_CANCEL_KIND = 'warehouse_transfer.cancel';

export interface CreateTransferResult {
  transfer: TransferResponseDto;
  isReplay: boolean;
}

export interface CancelTransferResult {
  transfer: TransferResponseDto;
  isReplay: boolean;
}

/**
 * Same-project warehouse transfers. One call posts an OUT and IN movement
 * carrying the exact same quantity and UZS value, and updates both balance
 * projections in the same project-locked Serializable transaction.
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly projectLock: ProjectLockService,
    private readonly audit: AuditService,
  ) {}

  async create(
    user: AuthenticatedUser,
    projectId: string,
    dto: CreateTransferDto,
    idempotencyKey: string,
    requestId?: string,
  ): Promise<CreateTransferResult> {
    const requestHash = computeRequestHash({
      kind: TRANSFER_CREATE_KIND,
      projectId,
      sourceWarehouseId: dto.sourceWarehouseId,
      destinationWarehouseId: dto.destinationWarehouseId,
      materialId: dto.materialId,
      quantity: dto.quantity,
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

        const replay = await this.findReplay(
          tx,
          projectId,
          user.id,
          TRANSFER_CREATE_KIND,
          idempotencyKey,
          requestHash,
        );
        if (replay) {
          const existing = await tx.warehouseTransfer.findUnique({
            where: { operationId: replay.id },
          });
          if (!existing) {
            throw new NotFoundException({
              code: 'NOT_FOUND',
              message: 'Replayed transfer not found',
            });
          }
          return { transfer: this.toResponse(existing), isReplay: true };
        }

        if (dto.sourceWarehouseId === dto.destinationWarehouseId) {
          throw new BadRequestException({
            code: 'VALIDATION_ERROR',
            message: 'Source and destination warehouses must be different',
          });
        }
        if (isFutureBusinessDate(dto.occurredAt, project.timezone)) {
          throw new BadRequestException({
            code: 'VALIDATION_ERROR',
            message: 'occurredAt cannot be a future business date',
          });
        }

        const warehouses = await tx.warehouse.findMany({
          where: {
            id: {
              in: [dto.sourceWarehouseId, dto.destinationWarehouseId],
            },
          },
        });
        const source = warehouses.find(
          (warehouse) => warehouse.id === dto.sourceWarehouseId,
        );
        const destination = warehouses.find(
          (warehouse) => warehouse.id === dto.destinationWarehouseId,
        );
        if (
          (source && source.projectId !== projectId) ||
          (destination && destination.projectId !== projectId)
        ) {
          throw new ConflictException({
            code: 'CROSS_PROJECT_TRANSFER_FORBIDDEN',
            message: 'Warehouse transfers must remain within one project',
          });
        }
        if (!source || !source.isActive) {
          throw new NotFoundException({
            code: 'NOT_FOUND',
            message: 'Source warehouse not found in this project',
          });
        }
        if (!destination || !destination.isActive) {
          throw new NotFoundException({
            code: 'NOT_FOUND',
            message: 'Destination warehouse not found in this project',
          });
        }

        const material = await tx.material.findFirst({
          where: { id: dto.materialId, projectId },
        });
        if (!material || !material.isActive) {
          throw new NotFoundException({
            code: 'NOT_FOUND',
            message: 'Material not found in this project',
          });
        }

        const [sourceBalance, destinationBalance] = await Promise.all([
          tx.inventoryBalance.findUnique({
            where: {
              warehouseId_materialId: {
                warehouseId: source.id,
                materialId: material.id,
              },
            },
          }),
          tx.inventoryBalance.findUnique({
            where: {
              warehouseId_materialId: {
                warehouseId: destination.id,
                materialId: material.id,
              },
            },
          }),
        ]);
        const quantity = new Prisma.Decimal(dto.quantity);
        let depleted: ReturnType<typeof depleteStock>;
        try {
          depleted = depleteStock(
            sourceBalance
              ? {
                  quantity: sourceBalance.quantity,
                  valueUzs: sourceBalance.valueUzs,
                }
              : {
                  quantity: new Prisma.Decimal(0),
                  valueUzs: new Prisma.Decimal(0),
                },
            quantity,
          );
        } catch (error) {
          if (error instanceof InsufficientStockError) {
            throw new ConflictException({
              code: 'INSUFFICIENT_STOCK',
              message: error.message,
            });
          }
          throw error;
        }

        const destinationQuantity = (
          destinationBalance?.quantity ?? new Prisma.Decimal(0)
        ).plus(quantity);
        const destinationValue = (
          destinationBalance?.valueUzs ?? new Prisma.Decimal(0)
        ).plus(depleted.totalCostUzs);
        const occurredAt = new Date(`${dto.occurredAt}T00:00:00.000Z`);
        const sequence = await this.projectLock.bumpPostingSequence(
          tx,
          projectId,
        );
        const operation = await tx.postedOperation.create({
          data: {
            projectId,
            actorId: user.id,
            kind: TRANSFER_CREATE_KIND,
            idempotencyKey,
            requestHash,
            occurredAt,
            sequence,
          },
        });
        const transfer = await tx.warehouseTransfer.create({
          data: {
            projectId,
            operationId: operation.id,
            sourceWarehouseId: source.id,
            sourceWarehouseNameSnapshot: source.name,
            destinationWarehouseId: destination.id,
            destinationWarehouseNameSnapshot: destination.name,
            materialId: material.id,
            materialNameSnapshot: material.name,
            quantity,
            unitCostUzs: depleted.unitCostUzs,
            totalCostUzs: depleted.totalCostUzs,
            comment: dto.comment ?? null,
            occurredAt,
            createdById: user.id,
          },
        });

        if (!sourceBalance) {
          // A positive transfer can never reach this branch after the stock
          // check; it exists only to keep the invariant explicit.
          throw new ConflictException({
            code: 'INSUFFICIENT_STOCK',
            message: 'Source warehouse has no stock for this material',
          });
        }
        await tx.inventoryBalance.update({
          where: { id: sourceBalance.id },
          data: {
            quantity: depleted.result.quantity,
            valueUzs: depleted.result.valueUzs,
          },
        });
        if (destinationBalance) {
          await tx.inventoryBalance.update({
            where: { id: destinationBalance.id },
            data: {
              quantity: destinationQuantity,
              valueUzs: destinationValue,
            },
          });
        } else {
          await tx.inventoryBalance.create({
            data: {
              projectId,
              warehouseId: destination.id,
              materialId: material.id,
              quantity: destinationQuantity,
              valueUzs: destinationValue,
            },
          });
        }

        await tx.stockMovement.createMany({
          data: [
            {
              projectId,
              operationId: operation.id,
              transferId: transfer.id,
              warehouseId: source.id,
              materialId: material.id,
              type: StockMovementType.TRANSFER_OUT,
              direction: TransactionDirection.OUT,
              quantity,
              unitCostUzs: depleted.unitCostUzs,
              totalCostUzs: depleted.totalCostUzs,
              occurredAt,
              createdById: user.id,
            },
            {
              projectId,
              operationId: operation.id,
              transferId: transfer.id,
              warehouseId: destination.id,
              materialId: material.id,
              type: StockMovementType.TRANSFER_IN,
              direction: TransactionDirection.IN,
              quantity,
              unitCostUzs: depleted.unitCostUzs,
              totalCostUzs: depleted.totalCostUzs,
              occurredAt,
              createdById: user.id,
            },
          ],
        });

        const response = this.toResponse(transfer);
        await this.audit.record(tx, {
          projectId,
          actorId: user.id,
          action: TRANSFER_CREATE_KIND,
          entityType: 'WarehouseTransfer',
          entityId: transfer.id,
          operationId: operation.id,
          requestId,
          newData: { ...response },
        });
        return { transfer: response, isReplay: false };
      });
    } catch (error) {
      const replay = await this.replayAfterUniqueConflict(
        error,
        projectId,
        user.id,
        TRANSFER_CREATE_KIND,
        idempotencyKey,
        requestHash,
      );
      if (replay) {
        const existing = await this.prisma.client.warehouseTransfer.findUnique({
          where: { operationId: replay.id },
        });
        if (existing) {
          return { transfer: this.toResponse(existing), isReplay: true };
        }
      }
      throw error;
    }
  }

  async list(
    user: AuthenticatedUser,
    projectId: string,
    query: ListTransfersQueryDto,
  ): Promise<PaginatedTransfersResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    const where: Prisma.WarehouseTransferWhereInput = { projectId };
    if (!query.includeCancelled) {
      where.cancelledAt = null;
    }
    if (query.warehouseId) {
      where.OR = [
        { sourceWarehouseId: query.warehouseId },
        { destinationWarehouseId: query.warehouseId },
      ];
    }
    if (query.materialId) {
      where.materialId = query.materialId;
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
      this.prisma.client.warehouseTransfer.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.client.warehouseTransfer.count({ where }),
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
    transferId: string,
  ): Promise<TransferResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    return this.toResponse(await this.getOrThrow(projectId, transferId));
  }

  async cancel(
    user: AuthenticatedUser,
    projectId: string,
    transferId: string,
    dto: CancelTransferDto,
    idempotencyKey: string,
    requestId?: string,
  ): Promise<CancelTransferResult> {
    const requestHash = computeRequestHash({
      kind: TRANSFER_CANCEL_KIND,
      projectId,
      transferId,
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
        const replay = await this.findReplay(
          tx,
          projectId,
          user.id,
          TRANSFER_CANCEL_KIND,
          idempotencyKey,
          requestHash,
        );
        if (replay) {
          if (!replay.reversalOfId) {
            throw new NotFoundException({
              code: 'NOT_FOUND',
              message: 'Replayed cancellation not found',
            });
          }
          const original = await tx.warehouseTransfer.findFirst({
            where: { projectId, operationId: replay.reversalOfId },
          });
          if (!original) {
            throw new NotFoundException({
              code: 'NOT_FOUND',
              message: 'Replayed cancellation not found',
            });
          }
          return { transfer: this.toResponse(original), isReplay: true };
        }

        const transfer = await tx.warehouseTransfer.findFirst({
          where: { id: transferId, projectId },
        });
        if (!transfer) {
          throw new NotFoundException({
            code: 'NOT_FOUND',
            message: 'Transfer not found in this project',
          });
        }
        if (transfer.cancelledAt) {
          throw new ConflictException({
            code: 'TRANSFER_ALREADY_CANCELLED',
            message: 'This transfer has already been cancelled',
          });
        }

        const originalOperation = await tx.postedOperation.findUniqueOrThrow({
          where: { id: transfer.operationId },
        });
        const reversedOperationIds = await loadReversedOperationIds(
          tx,
          projectId,
        );
        for (const warehouseId of [
          transfer.sourceWarehouseId,
          transfer.destinationWarehouseId,
        ]) {
          if (
            await hasLaterEffectiveMovement(tx, {
              projectId,
              warehouseId,
              materialId: transfer.materialId,
              afterSequence: originalOperation.sequence,
              reversedOperationIds,
            })
          ) {
            throw new ConflictException({
              code: 'CANCELLATION_HAS_DEPENDENCIES',
              message:
                'A later inventory movement depends on this transfer; it cannot be cancelled',
            });
          }
        }

        const sourceBalance = await tx.inventoryBalance.findUniqueOrThrow({
          where: {
            warehouseId_materialId: {
              warehouseId: transfer.sourceWarehouseId,
              materialId: transfer.materialId,
            },
          },
        });
        const destinationBalance = await tx.inventoryBalance.findUniqueOrThrow({
          where: {
            warehouseId_materialId: {
              warehouseId: transfer.destinationWarehouseId,
              materialId: transfer.materialId,
            },
          },
        });
        if (destinationBalance.quantity.lessThan(transfer.quantity)) {
          throw new ConflictException({
            code: 'CANCELLATION_HAS_DEPENDENCIES',
            message:
              'Destination stock no longer contains the transferred quantity',
          });
        }

        const isEntireDestination = destinationBalance.quantity.equals(
          transfer.quantity,
        );
        const destinationQuantity = isEntireDestination
          ? new Prisma.Decimal(0)
          : destinationBalance.quantity.minus(transfer.quantity);
        const destinationValue = isEntireDestination
          ? new Prisma.Decimal(0)
          : destinationBalance.valueUzs.minus(transfer.totalCostUzs);
        if (destinationValue.isNegative()) {
          throw new ConflictException({
            code: 'CANCELLATION_HAS_DEPENDENCIES',
            message:
              'Destination stock value no longer contains the transfer value',
          });
        }

        const sequence = await this.projectLock.bumpPostingSequence(
          tx,
          projectId,
        );
        const reversalOperation = await tx.postedOperation.create({
          data: {
            projectId,
            actorId: user.id,
            kind: TRANSFER_CANCEL_KIND,
            idempotencyKey,
            requestHash,
            occurredAt: transfer.occurredAt,
            sequence,
            reversalOfId: transfer.operationId,
          },
        });
        await tx.inventoryBalance.update({
          where: { id: sourceBalance.id },
          data: {
            quantity: sourceBalance.quantity.plus(transfer.quantity),
            valueUzs: sourceBalance.valueUzs.plus(transfer.totalCostUzs),
          },
        });
        await tx.inventoryBalance.update({
          where: { id: destinationBalance.id },
          data: { quantity: destinationQuantity, valueUzs: destinationValue },
        });
        await tx.stockMovement.createMany({
          data: [
            {
              projectId,
              operationId: reversalOperation.id,
              transferId: transfer.id,
              warehouseId: transfer.sourceWarehouseId,
              materialId: transfer.materialId,
              type: StockMovementType.REVERSAL,
              direction: TransactionDirection.IN,
              quantity: transfer.quantity,
              unitCostUzs: transfer.unitCostUzs,
              totalCostUzs: transfer.totalCostUzs,
              occurredAt: transfer.occurredAt,
              createdById: user.id,
            },
            {
              projectId,
              operationId: reversalOperation.id,
              transferId: transfer.id,
              warehouseId: transfer.destinationWarehouseId,
              materialId: transfer.materialId,
              type: StockMovementType.REVERSAL,
              direction: TransactionDirection.OUT,
              quantity: transfer.quantity,
              unitCostUzs: transfer.unitCostUzs,
              totalCostUzs: transfer.totalCostUzs,
              occurredAt: transfer.occurredAt,
              createdById: user.id,
            },
          ],
        });
        const cancelled = await tx.warehouseTransfer.update({
          where: { id: transfer.id },
          data: {
            cancelledAt: new Date(),
            cancellationReason: dto.reason,
            cancelledById: user.id,
          },
        });
        const response = this.toResponse(cancelled);
        await this.audit.record(tx, {
          projectId,
          actorId: user.id,
          action: TRANSFER_CANCEL_KIND,
          entityType: 'WarehouseTransfer',
          entityId: transfer.id,
          operationId: reversalOperation.id,
          requestId,
          previousData: { ...this.toResponse(transfer) },
          newData: { ...response },
        });
        return { transfer: response, isReplay: false };
      });
    } catch (error) {
      const replay = await this.replayAfterUniqueConflict(
        error,
        projectId,
        user.id,
        TRANSFER_CANCEL_KIND,
        idempotencyKey,
        requestHash,
      );
      if (replay?.reversalOfId) {
        const original = await this.prisma.client.warehouseTransfer.findFirst({
          where: { projectId, operationId: replay.reversalOfId },
        });
        if (original) {
          return { transfer: this.toResponse(original), isReplay: true };
        }
      }
      throw error;
    }
  }

  private async findReplay(
    tx: PrismaTx,
    projectId: string,
    actorId: string,
    kind: string,
    idempotencyKey: string,
    requestHash: string,
  ) {
    const operation = await tx.postedOperation.findUnique({
      where: {
        projectId_actorId_kind_idempotencyKey: {
          projectId,
          actorId,
          kind,
          idempotencyKey,
        },
      },
    });
    if (operation && operation.requestHash !== requestHash) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message:
          'This Idempotency-Key was already used with a different request payload',
      });
    }
    return operation;
  }

  private async replayAfterUniqueConflict(
    error: unknown,
    projectId: string,
    actorId: string,
    kind: string,
    idempotencyKey: string,
    requestHash: string,
  ) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== 'P2002'
    ) {
      return null;
    }
    const operation = await this.prisma.client.postedOperation.findUnique({
      where: {
        projectId_actorId_kind_idempotencyKey: {
          projectId,
          actorId,
          kind,
          idempotencyKey,
        },
      },
    });
    return operation?.requestHash === requestHash ? operation : null;
  }

  private async getOrThrow(
    projectId: string,
    transferId: string,
  ): Promise<WarehouseTransfer> {
    const transfer = await this.prisma.client.warehouseTransfer.findFirst({
      where: { id: transferId, projectId },
    });
    if (!transfer) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Transfer not found in this project',
      });
    }
    return transfer;
  }

  private toResponse(transfer: WarehouseTransfer): TransferResponseDto {
    return {
      id: transfer.id,
      projectId: transfer.projectId,
      sourceWarehouseId: transfer.sourceWarehouseId,
      sourceWarehouseNameSnapshot: transfer.sourceWarehouseNameSnapshot,
      destinationWarehouseId: transfer.destinationWarehouseId,
      destinationWarehouseNameSnapshot:
        transfer.destinationWarehouseNameSnapshot,
      materialId: transfer.materialId,
      materialNameSnapshot: transfer.materialNameSnapshot,
      quantity: transfer.quantity.toFixed(6),
      unitCostUzs: transfer.unitCostUzs.toFixed(8),
      totalCostUzs: transfer.totalCostUzs.toFixed(8),
      comment: transfer.comment,
      occurredAt: transfer.occurredAt.toISOString().slice(0, 10),
      createdById: transfer.createdById,
      createdAt: transfer.createdAt,
      cancelledAt: transfer.cancelledAt,
      cancellationReason: transfer.cancellationReason,
      cancelledById: transfer.cancelledById,
    };
  }
}
