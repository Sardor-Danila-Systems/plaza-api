import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { computeRequestHash } from '../../../common/idempotency/request-hash.util.js';
import { isFutureBusinessDate } from '../../../common/date/business-date.util.js';
import {
  InsufficientStockError,
  depleteStock,
} from '../../../common/inventory/costing.util.js';
import {
  hasLaterEffectiveMovement,
  loadReversedOperationIds,
} from '../../../common/inventory/dependency-check.util.js';
import { ProjectLockService } from '../../../database/project-lock.service.js';
import { PrismaService } from '../../../database/prisma.service.js';
import {
  Prisma,
  StockMovementType,
  StockWriteOff,
  TransactionDirection,
} from '../../../generated/prisma/client.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { ProjectAccessAction } from '../../projects/project-access-action.enum.js';
import { ProjectAccessService } from '../../projects/project-access.service.js';
import { CancelWriteOffDto } from './dto/cancel-write-off.dto.js';
import { CreateWriteOffDto } from './dto/create-write-off.dto.js';
import { ListWriteOffsQueryDto } from './dto/list-write-offs-query.dto.js';
import { PaginatedWriteOffsResponseDto } from './dto/paginated-write-offs-response.dto.js';
import { WriteOffResponseDto } from './dto/write-off-response.dto.js';

const WRITE_OFF_CREATE_KIND = 'stock_write_off.create';
const WRITE_OFF_CANCEL_KIND = 'stock_write_off.cancel';

export interface CreateWriteOffResult {
  writeOff: WriteOffResponseDto;
  isReplay: boolean;
}

export interface CancelWriteOffResult {
  writeOff: WriteOffResponseDto;
  isReplay: boolean;
}

/**
 * Construction-consumption write-offs (transaction-design.md §6's outbound
 * formula, docs/backend-architecture.md §7: "A write-off creates no cash
 * transaction"). Valued at the CURRENT weighted-average cost, fixed forever
 * afterward — a later purchase changing the average never rewrites a
 * posted write-off (invariant #15).
 */
@Injectable()
export class WriteOffsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly projectLock: ProjectLockService,
    private readonly audit: AuditService,
  ) {}

  async create(
    user: AuthenticatedUser,
    projectId: string,
    dto: CreateWriteOffDto,
    idempotencyKey: string,
    requestId?: string,
  ): Promise<CreateWriteOffResult> {
    const requestHash = computeRequestHash({
      kind: WRITE_OFF_CREATE_KIND,
      projectId,
      warehouseId: dto.warehouseId,
      materialId: dto.materialId,
      blockId: dto.blockId,
      floorId: dto.floorId,
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

        const existingOperation = await tx.postedOperation.findUnique({
          where: {
            projectId_actorId_kind_idempotencyKey: {
              projectId,
              actorId: user.id,
              kind: WRITE_OFF_CREATE_KIND,
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
          const existing = await tx.stockWriteOff.findUnique({
            where: { operationId: existingOperation.id },
          });
          if (!existing) {
            throw new NotFoundException({
              code: 'NOT_FOUND',
              message: 'Replayed write-off not found',
            });
          }
          return { writeOff: this.toResponse(existing), isReplay: true };
        }

        if (isFutureBusinessDate(dto.occurredAt, project.timezone)) {
          throw new BadRequestException({
            code: 'VALIDATION_ERROR',
            message: 'occurredAt cannot be a future business date',
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
        const material = await tx.material.findFirst({
          where: { id: dto.materialId, projectId },
        });
        if (!material || !material.isActive) {
          throw new NotFoundException({
            code: 'NOT_FOUND',
            message: 'Material not found in this project',
          });
        }
        const block = await tx.buildingBlock.findFirst({
          where: { id: dto.blockId, projectId },
        });
        if (!block || !block.isActive) {
          throw new NotFoundException({
            code: 'NOT_FOUND',
            message: 'Building block not found in this project',
          });
        }
        // Composite FK shape: the floor must belong to THIS block.
        const floor = await tx.floor.findFirst({
          where: { id: dto.floorId, projectId, blockId: dto.blockId },
        });
        if (!floor || !floor.isActive) {
          throw new NotFoundException({
            code: 'NOT_FOUND',
            message: 'Floor not found for this building block',
          });
        }

        const quantity = new Prisma.Decimal(dto.quantity);
        const existingBalance = await tx.inventoryBalance.findUnique({
          where: {
            warehouseId_materialId: {
              warehouseId: warehouse.id,
              materialId: material.id,
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

        let depleted: ReturnType<typeof depleteStock>;
        try {
          depleted = depleteStock(currentPosition, quantity);
        } catch (error) {
          if (error instanceof InsufficientStockError) {
            throw new ConflictException({
              code: 'INSUFFICIENT_STOCK',
              message: error.message,
            });
          }
          throw error;
        }

        const occurredAt = new Date(`${dto.occurredAt}T00:00:00.000Z`);
        const sequence = await this.projectLock.bumpPostingSequence(
          tx,
          projectId,
        );
        const operation = await tx.postedOperation.create({
          data: {
            projectId,
            actorId: user.id,
            kind: WRITE_OFF_CREATE_KIND,
            idempotencyKey,
            requestHash,
            occurredAt,
            sequence,
          },
        });

        const writeOff = await tx.stockWriteOff.create({
          data: {
            projectId,
            operationId: operation.id,
            warehouseId: warehouse.id,
            warehouseNameSnapshot: warehouse.name,
            materialId: material.id,
            materialNameSnapshot: material.name,
            blockId: block.id,
            blockNameSnapshot: block.name,
            floorId: floor.id,
            floorLabelSnapshot: floor.label,
            quantity,
            unitCostUzs: depleted.unitCostUzs,
            totalCostUzs: depleted.totalCostUzs,
            comment: dto.comment ?? null,
            occurredAt,
            createdById: user.id,
          },
        });

        if (existingBalance) {
          await tx.inventoryBalance.update({
            where: { id: existingBalance.id },
            data: {
              quantity: depleted.result.quantity,
              valueUzs: depleted.result.valueUzs,
            },
          });
        } else {
          // Only reachable if `quantity` were 0, which the DTO's positivity
          // rule already forbids — kept for defense-in-depth symmetry with
          // Purchase's own receipt path, not an expected runtime path.
          await tx.inventoryBalance.create({
            data: {
              projectId,
              warehouseId: warehouse.id,
              materialId: material.id,
              quantity: depleted.result.quantity,
              valueUzs: depleted.result.valueUzs,
            },
          });
        }

        await tx.stockMovement.create({
          data: {
            projectId,
            operationId: operation.id,
            writeOffId: writeOff.id,
            warehouseId: warehouse.id,
            materialId: material.id,
            type: StockMovementType.WRITE_OFF,
            direction: TransactionDirection.OUT,
            quantity,
            unitCostUzs: depleted.unitCostUzs,
            totalCostUzs: depleted.totalCostUzs,
            occurredAt,
            createdById: user.id,
          },
        });

        const response = this.toResponse(writeOff);
        await this.audit.record(tx, {
          projectId,
          actorId: user.id,
          action: WRITE_OFF_CREATE_KIND,
          entityType: 'StockWriteOff',
          entityId: writeOff.id,
          operationId: operation.id,
          requestId,
          newData: { ...response },
        });

        return { writeOff: response, isReplay: false };
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
                kind: WRITE_OFF_CREATE_KIND,
                idempotencyKey,
              },
            },
          });
        if (
          existingOperation &&
          existingOperation.requestHash === requestHash
        ) {
          const existing = await this.prisma.client.stockWriteOff.findUnique({
            where: { operationId: existingOperation.id },
          });
          if (existing) {
            return { writeOff: this.toResponse(existing), isReplay: true };
          }
        }
      }
      throw error;
    }
  }

  async list(
    user: AuthenticatedUser,
    projectId: string,
    query: ListWriteOffsQueryDto,
  ): Promise<PaginatedWriteOffsResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );

    const where: Prisma.StockWriteOffWhereInput = { projectId };
    if (!query.includeCancelled) {
      where.cancelledAt = null;
    }
    if (query.warehouseId) {
      where.warehouseId = query.warehouseId;
    }
    if (query.materialId) {
      where.materialId = query.materialId;
    }
    if (query.blockId) {
      where.blockId = query.blockId;
    }
    if (query.floorId) {
      where.floorId = query.floorId;
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
      this.prisma.client.stockWriteOff.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.client.stockWriteOff.count({ where }),
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
    writeOffId: string,
  ): Promise<WriteOffResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    return this.toResponse(await this.getOrThrow(projectId, writeOffId));
  }

  /**
   * Dependency-checked cancellation (transaction-design.md §8, simplified
   * per this codebase's own operation-sequence dependency check —
   * see `src/common/inventory/dependency-check.util.ts`). Restoring the
   * balance is a pure addition (never a subtraction), so — unlike Purchase
   * cancellation's receipt reversal — there is no full-depletion "land
   * exactly on zero" concern here.
   */
  async cancel(
    user: AuthenticatedUser,
    projectId: string,
    writeOffId: string,
    dto: CancelWriteOffDto,
    idempotencyKey: string,
    requestId?: string,
  ): Promise<CancelWriteOffResult> {
    const requestHash = computeRequestHash({
      kind: WRITE_OFF_CANCEL_KIND,
      projectId,
      writeOffId,
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
              kind: WRITE_OFF_CANCEL_KIND,
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
          const original = await tx.stockWriteOff.findFirst({
            where: { operationId: existingOperation.reversalOfId, projectId },
          });
          if (!original) {
            throw new NotFoundException({
              code: 'NOT_FOUND',
              message: 'Replayed cancellation not found',
            });
          }
          return { writeOff: this.toResponse(original), isReplay: true };
        }

        const writeOff = await tx.stockWriteOff.findFirst({
          where: { id: writeOffId, projectId },
        });
        if (!writeOff) {
          throw new NotFoundException({
            code: 'NOT_FOUND',
            message: 'Write-off not found in this project',
          });
        }
        if (writeOff.cancelledAt) {
          throw new ConflictException({
            code: 'WRITE_OFF_ALREADY_CANCELLED',
            message: 'This write-off has already been cancelled',
          });
        }

        const writeOffOperation = await tx.postedOperation.findUniqueOrThrow({
          where: { id: writeOff.operationId },
        });
        const reversedOperationIds = await loadReversedOperationIds(
          tx,
          projectId,
        );
        const blocked = await hasLaterEffectiveMovement(tx, {
          projectId,
          warehouseId: writeOff.warehouseId,
          materialId: writeOff.materialId,
          afterSequence: writeOffOperation.sequence,
          reversedOperationIds,
        });
        if (blocked) {
          throw new ConflictException({
            code: 'CANCELLATION_HAS_DEPENDENCIES',
            message:
              'A later inventory movement depends on this balance; the write-off cannot be cancelled',
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
            kind: WRITE_OFF_CANCEL_KIND,
            idempotencyKey,
            requestHash,
            occurredAt: writeOff.occurredAt,
            sequence,
            reversalOfId: writeOff.operationId,
          },
        });

        const balance = await tx.inventoryBalance.findUniqueOrThrow({
          where: {
            warehouseId_materialId: {
              warehouseId: writeOff.warehouseId,
              materialId: writeOff.materialId,
            },
          },
        });
        await tx.inventoryBalance.update({
          where: { id: balance.id },
          data: {
            quantity: balance.quantity.plus(writeOff.quantity),
            valueUzs: balance.valueUzs.plus(writeOff.totalCostUzs),
          },
        });
        await tx.stockMovement.create({
          data: {
            projectId,
            operationId: reversalOperation.id,
            writeOffId: writeOff.id,
            warehouseId: writeOff.warehouseId,
            materialId: writeOff.materialId,
            type: StockMovementType.REVERSAL,
            direction: TransactionDirection.IN,
            quantity: writeOff.quantity,
            unitCostUzs: writeOff.unitCostUzs,
            totalCostUzs: writeOff.totalCostUzs,
            occurredAt: writeOff.occurredAt,
            createdById: user.id,
          },
        });

        const cancelled = await tx.stockWriteOff.update({
          where: { id: writeOff.id },
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
          action: WRITE_OFF_CANCEL_KIND,
          entityType: 'StockWriteOff',
          entityId: writeOff.id,
          operationId: reversalOperation.id,
          requestId,
          previousData: { ...this.toResponse(writeOff) },
          newData: { ...response },
        });

        return { writeOff: response, isReplay: false };
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
                kind: WRITE_OFF_CANCEL_KIND,
                idempotencyKey,
              },
            },
          });
        if (
          existingOperation &&
          existingOperation.requestHash === requestHash &&
          existingOperation.reversalOfId
        ) {
          const original = await this.prisma.client.stockWriteOff.findFirst({
            where: { operationId: existingOperation.reversalOfId, projectId },
          });
          if (original) {
            return { writeOff: this.toResponse(original), isReplay: true };
          }
        }
      }
      throw error;
    }
  }

  private async getOrThrow(
    projectId: string,
    writeOffId: string,
  ): Promise<StockWriteOff> {
    const writeOff = await this.prisma.client.stockWriteOff.findFirst({
      where: { id: writeOffId, projectId },
    });
    if (!writeOff) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Write-off not found in this project',
      });
    }
    return writeOff;
  }

  private toResponse(writeOff: StockWriteOff): WriteOffResponseDto {
    return {
      id: writeOff.id,
      projectId: writeOff.projectId,
      warehouseId: writeOff.warehouseId,
      warehouseNameSnapshot: writeOff.warehouseNameSnapshot,
      materialId: writeOff.materialId,
      materialNameSnapshot: writeOff.materialNameSnapshot,
      blockId: writeOff.blockId,
      blockNameSnapshot: writeOff.blockNameSnapshot,
      floorId: writeOff.floorId,
      floorLabelSnapshot: writeOff.floorLabelSnapshot,
      quantity: writeOff.quantity.toFixed(6),
      unitCostUzs: writeOff.unitCostUzs.toFixed(8),
      totalCostUzs: writeOff.totalCostUzs.toFixed(8),
      comment: writeOff.comment,
      occurredAt: writeOff.occurredAt.toISOString().slice(0, 10),
      createdById: writeOff.createdById,
      createdAt: writeOff.createdAt,
      cancelledAt: writeOff.cancelledAt,
      cancellationReason: writeOff.cancellationReason,
      cancelledById: writeOff.cancelledById,
    };
  }
}
