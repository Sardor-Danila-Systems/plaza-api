import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service.js';
import { MaterialCategory, Prisma } from '../../../generated/prisma/client.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { ProjectAccessAction } from '../../projects/project-access-action.enum.js';
import { ProjectAccessService } from '../../projects/project-access.service.js';
import { CreateMaterialCategoryDto } from './dto/create-material-category.dto.js';
import { MaterialCategoryResponseDto } from './dto/material-category-response.dto.js';
import { UpdateMaterialCategoryDto } from './dto/update-material-category.dto.js';

@Injectable()
export class MaterialCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly audit: AuditService,
  ) {}

  async list(
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<MaterialCategoryResponseDto[]> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    const categories = await this.prisma.client.materialCategory.findMany({
      where: { projectId },
      orderBy: { name: 'asc' },
    });
    return categories.map(this.toResponse);
  }

  async create(
    user: AuthenticatedUser,
    projectId: string,
    dto: CreateMaterialCategoryDto,
    requestId?: string,
  ): Promise<MaterialCategoryResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.WRITE,
    );

    let category: MaterialCategory;
    try {
      category = await this.prisma.client.materialCategory.create({
        data: { projectId, name: dto.name },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'UNIQUE_CONSTRAINT_VIOLATION',
          message: `A material category named "${dto.name}" already exists in this project`,
        });
      }
      throw error;
    }

    await this.prisma.client.$transaction(async (tx) => {
      await this.audit.record(tx, {
        projectId,
        actorId: user.id,
        action: 'material_category.create',
        entityType: 'MaterialCategory',
        entityId: category.id,
        requestId,
        newData: { ...this.toResponse(category) },
      });
    });

    return this.toResponse(category);
  }

  async update(
    user: AuthenticatedUser,
    projectId: string,
    categoryId: string,
    dto: UpdateMaterialCategoryDto,
    requestId?: string,
  ): Promise<MaterialCategoryResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.WRITE,
    );
    const existing = await this.getCategoryOrThrow(projectId, categoryId);

    const updated = await this.prisma.client.$transaction(async (tx) => {
      const category = await tx.materialCategory.update({
        where: { id: categoryId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
      await this.audit.record(tx, {
        projectId,
        actorId: user.id,
        action: 'material_category.update',
        entityType: 'MaterialCategory',
        entityId: category.id,
        requestId,
        previousData: { ...this.toResponse(existing) },
        newData: { ...this.toResponse(category) },
      });
      return category;
    });

    return this.toResponse(updated);
  }

  async getCategoryOrThrow(
    projectId: string,
    categoryId: string,
  ): Promise<MaterialCategory> {
    const category = await this.prisma.client.materialCategory.findFirst({
      where: { id: categoryId, projectId },
    });
    if (!category) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Material category not found in this project',
      });
    }
    return category;
  }

  private toResponse(category: MaterialCategory): MaterialCategoryResponseDto {
    return {
      id: category.id,
      projectId: category.projectId,
      name: category.name,
      isActive: category.isActive,
      createdAt: category.createdAt,
    };
  }
}
