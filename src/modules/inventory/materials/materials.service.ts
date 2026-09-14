import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service.js';
import { Material, Prisma } from '../../../generated/prisma/client.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { ProjectAccessAction } from '../../projects/project-access-action.enum.js';
import { ProjectAccessService } from '../../projects/project-access.service.js';
import { CreateMaterialDto } from './dto/create-material.dto.js';
import { ListMaterialsQueryDto } from './dto/list-materials-query.dto.js';
import { MaterialResponseDto } from './dto/material-response.dto.js';
import { UpdateMaterialDto } from './dto/update-material.dto.js';

@Injectable()
export class MaterialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly audit: AuditService,
  ) {}

  async list(
    user: AuthenticatedUser,
    projectId: string,
    query: ListMaterialsQueryDto,
  ): Promise<MaterialResponseDto[]> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );

    const where: Prisma.MaterialWhereInput = { projectId };
    if (query.categoryId) {
      where.categoryId = query.categoryId;
    }
    if (query.isActive !== undefined) {
      where.isActive = query.isActive;
    }
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { code: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const materials = await this.prisma.client.material.findMany({
      where,
      orderBy: { name: 'asc' },
    });
    return materials.map(this.toResponse);
  }

  async get(
    user: AuthenticatedUser,
    projectId: string,
    materialId: string,
  ): Promise<MaterialResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    const material = await this.getMaterialOrThrow(projectId, materialId);
    return this.toResponse(material);
  }

  async create(
    user: AuthenticatedUser,
    projectId: string,
    dto: CreateMaterialDto,
    requestId?: string,
  ): Promise<MaterialResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.WRITE,
    );

    const [category, unit] = await Promise.all([
      this.prisma.client.materialCategory.findFirst({
        where: { id: dto.categoryId, projectId },
      }),
      this.prisma.client.unit.findFirst({
        where: { id: dto.unitId, projectId },
      }),
    ]);
    if (!category) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Material category not found in this project',
      });
    }
    if (!unit) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Unit not found in this project',
      });
    }

    let material: Material;
    try {
      material = await this.prisma.client.material.create({
        data: {
          projectId,
          name: dto.name,
          code: dto.code,
          categoryId: dto.categoryId,
          unitId: dto.unitId,
          minimumStock: dto.minimumStock
            ? new Prisma.Decimal(dto.minimumStock)
            : null,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'UNIQUE_CONSTRAINT_VIOLATION',
          message: `A material with code "${dto.code}" already exists in this project`,
        });
      }
      throw error;
    }

    await this.prisma.client.$transaction(async (tx) => {
      await this.audit.record(tx, {
        projectId,
        actorId: user.id,
        action: 'material.create',
        entityType: 'Material',
        entityId: material.id,
        requestId,
        newData: { ...this.toResponse(material) },
      });
    });

    return this.toResponse(material);
  }

  async update(
    user: AuthenticatedUser,
    projectId: string,
    materialId: string,
    dto: UpdateMaterialDto,
    requestId?: string,
  ): Promise<MaterialResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.WRITE,
    );
    const existing = await this.getMaterialOrThrow(projectId, materialId);

    if (dto.categoryId) {
      const category = await this.prisma.client.materialCategory.findFirst({
        where: { id: dto.categoryId, projectId },
      });
      if (!category) {
        throw new NotFoundException({
          code: 'NOT_FOUND',
          message: 'Material category not found in this project',
        });
      }
    }
    const updated = await this.prisma.client.$transaction(async (tx) => {
      const material = await tx.material.update({
        where: { id: materialId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.categoryId !== undefined
            ? { categoryId: dto.categoryId }
            : {}),
          ...(dto.minimumStock !== undefined
            ? {
                minimumStock:
                  dto.minimumStock === null
                    ? null
                    : new Prisma.Decimal(dto.minimumStock),
              }
            : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
      await this.audit.record(tx, {
        projectId,
        actorId: user.id,
        action: 'material.update',
        entityType: 'Material',
        entityId: material.id,
        requestId,
        previousData: { ...this.toResponse(existing) },
        newData: { ...this.toResponse(material) },
      });
      return material;
    });

    return this.toResponse(updated);
  }

  async getMaterialOrThrow(
    projectId: string,
    materialId: string,
  ): Promise<Material> {
    const material = await this.prisma.client.material.findFirst({
      where: { id: materialId, projectId },
    });
    if (!material) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Material not found in this project',
      });
    }
    return material;
  }

  private toResponse(material: Material): MaterialResponseDto {
    return {
      id: material.id,
      projectId: material.projectId,
      name: material.name,
      code: material.code,
      categoryId: material.categoryId,
      unitId: material.unitId,
      minimumStock: material.minimumStock
        ? material.minimumStock.toFixed(6)
        : null,
      isActive: material.isActive,
      createdAt: material.createdAt,
    };
  }
}
