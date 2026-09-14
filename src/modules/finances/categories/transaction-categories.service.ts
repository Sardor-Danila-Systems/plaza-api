import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { TransactionCategory } from '../../../generated/prisma/client.js';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { ProjectAccessAction } from '../../projects/project-access-action.enum.js';
import { ProjectAccessService } from '../../projects/project-access.service.js';
import { CreateTransactionCategoryDto } from './dto/create-transaction-category.dto.js';
import { TransactionCategoryResponseDto } from './dto/transaction-category-response.dto.js';
import { UpdateTransactionCategoryDto } from './dto/update-transaction-category.dto.js';

@Injectable()
export class TransactionCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  async list(
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<TransactionCategoryResponseDto[]> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    const categories = await this.prisma.client.transactionCategory.findMany({
      where: { projectId },
      orderBy: { name: 'asc' },
    });
    return categories.map(this.toResponse);
  }

  async create(
    user: AuthenticatedUser,
    projectId: string,
    dto: CreateTransactionCategoryDto,
  ): Promise<TransactionCategoryResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.WRITE,
    );
    try {
      const category = await this.prisma.client.transactionCategory.create({
        data: { projectId, name: dto.name, kind: dto.kind },
      });
      return this.toResponse(category);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'UNIQUE_CONSTRAINT_VIOLATION',
          message: `A ${dto.kind} category named "${dto.name}" already exists in this project`,
        });
      }
      throw error;
    }
  }

  async update(
    user: AuthenticatedUser,
    projectId: string,
    categoryId: string,
    dto: UpdateTransactionCategoryDto,
  ): Promise<TransactionCategoryResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.WRITE,
    );
    await this.getCategoryOrThrow(projectId, categoryId);

    const category = await this.prisma.client.transactionCategory.update({
      where: { id: categoryId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
    return this.toResponse(category);
  }

  /**
   * Same "belongs to a different project == doesn't exist" 404 shape as
   * `BlocksService.getBlockOrThrow` (Phase 3 §14 pattern).
   */
  async getCategoryOrThrow(
    projectId: string,
    categoryId: string,
  ): Promise<TransactionCategory> {
    const category = await this.prisma.client.transactionCategory.findFirst({
      where: { id: categoryId, projectId },
    });
    if (!category) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Transaction category not found in this project',
      });
    }
    return category;
  }

  private toResponse(
    category: TransactionCategory,
  ): TransactionCategoryResponseDto {
    return {
      id: category.id,
      projectId: category.projectId,
      name: category.name,
      kind: category.kind,
      isActive: category.isActive,
      createdAt: category.createdAt,
    };
  }
}
