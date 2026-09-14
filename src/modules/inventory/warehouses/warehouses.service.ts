import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service.js';
import { Prisma, Warehouse } from '../../../generated/prisma/client.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { ProjectAccessAction } from '../../projects/project-access-action.enum.js';
import { ProjectAccessService } from '../../projects/project-access.service.js';
import { CreateWarehouseDto } from './dto/create-warehouse.dto.js';
import { UpdateWarehouseDto } from './dto/update-warehouse.dto.js';
import { WarehouseResponseDto } from './dto/warehouse-response.dto.js';

/**
 * Master-data CRUD, the same shape as Phase 3's `BlocksService` — no
 * project lock: creating/renaming/archiving a warehouse never touches a
 * balance or any row a concurrent inventory read depends on for its own
 * correctness (transaction-design.md §1 lists exactly which workflows need
 * the lock; master-data-like master data isn't one of them).
 */
@Injectable()
export class WarehousesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly audit: AuditService,
  ) {}

  async list(
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<WarehouseResponseDto[]> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    const warehouses = await this.prisma.client.warehouse.findMany({
      where: { projectId },
      orderBy: { name: 'asc' },
    });
    return warehouses.map(this.toResponse);
  }

  async get(
    user: AuthenticatedUser,
    projectId: string,
    warehouseId: string,
  ): Promise<WarehouseResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    const warehouse = await this.getWarehouseOrThrow(projectId, warehouseId);
    return this.toResponse(warehouse);
  }

  async create(
    user: AuthenticatedUser,
    projectId: string,
    dto: CreateWarehouseDto,
    requestId?: string,
  ): Promise<WarehouseResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.WRITE,
    );

    let warehouse: Warehouse;
    try {
      warehouse = await this.prisma.client.warehouse.create({
        data: {
          projectId,
          name: dto.name,
          code: dto.code,
          comment: dto.comment,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'UNIQUE_CONSTRAINT_VIOLATION',
          message: `A warehouse with code "${dto.code}" already exists in this project`,
        });
      }
      throw error;
    }

    await this.prisma.client.$transaction(async (tx) => {
      await this.audit.record(tx, {
        projectId,
        actorId: user.id,
        action: 'warehouse.create',
        entityType: 'Warehouse',
        entityId: warehouse.id,
        requestId,
        newData: { ...this.toResponse(warehouse) },
      });
    });

    return this.toResponse(warehouse);
  }

  async update(
    user: AuthenticatedUser,
    projectId: string,
    warehouseId: string,
    dto: UpdateWarehouseDto,
    requestId?: string,
  ): Promise<WarehouseResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.WRITE,
    );
    const existing = await this.getWarehouseOrThrow(projectId, warehouseId);

    const updated = await this.prisma.client.$transaction(async (tx) => {
      const warehouse = await tx.warehouse.update({
        where: { id: warehouseId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.comment !== undefined ? { comment: dto.comment } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
      await this.audit.record(tx, {
        projectId,
        actorId: user.id,
        action: 'warehouse.update',
        entityType: 'Warehouse',
        entityId: warehouse.id,
        requestId,
        previousData: { ...this.toResponse(existing) },
        newData: { ...this.toResponse(warehouse) },
      });
      return warehouse;
    });

    return this.toResponse(updated);
  }

  /** Same "belongs to a different project == doesn't exist" 404 shape as
   * Phase 3's `BlocksService.getBlockOrThrow`. */
  async getWarehouseOrThrow(
    projectId: string,
    warehouseId: string,
  ): Promise<Warehouse> {
    const warehouse = await this.prisma.client.warehouse.findFirst({
      where: { id: warehouseId, projectId },
    });
    if (!warehouse) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Warehouse not found in this project',
      });
    }
    return warehouse;
  }

  private toResponse(warehouse: Warehouse): WarehouseResponseDto {
    return {
      id: warehouse.id,
      projectId: warehouse.projectId,
      name: warehouse.name,
      code: warehouse.code,
      comment: warehouse.comment,
      isActive: warehouse.isActive,
      createdAt: warehouse.createdAt,
    };
  }
}
