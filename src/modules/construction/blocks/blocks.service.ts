import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service.js';
import { BuildingBlock } from '../../../generated/prisma/client.js';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { ProjectAccessAction } from '../../projects/project-access-action.enum.js';
import { ProjectAccessService } from '../../projects/project-access.service.js';
import { BuildingBlockResponseDto } from './dto/building-block-response.dto.js';
import { CreateBuildingBlockDto } from './dto/create-building-block.dto.js';
import { UpdateBuildingBlockDto } from './dto/update-building-block.dto.js';

@Injectable()
export class BlocksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  async list(
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<BuildingBlockResponseDto[]> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    const blocks = await this.prisma.client.buildingBlock.findMany({
      where: { projectId },
      orderBy: { name: 'asc' },
    });
    return blocks.map(this.toResponse);
  }

  async get(
    user: AuthenticatedUser,
    projectId: string,
    blockId: string,
  ): Promise<BuildingBlockResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    const block = await this.getBlockOrThrow(projectId, blockId);
    return this.toResponse(block);
  }

  async create(
    user: AuthenticatedUser,
    projectId: string,
    dto: CreateBuildingBlockDto,
  ): Promise<BuildingBlockResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.WRITE,
    );
    const block = await this.prisma.client.buildingBlock.create({
      data: { projectId, name: dto.name, code: dto.code },
    });
    return this.toResponse(block);
  }

  async update(
    user: AuthenticatedUser,
    projectId: string,
    blockId: string,
    dto: UpdateBuildingBlockDto,
  ): Promise<BuildingBlockResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.WRITE,
    );
    await this.getBlockOrThrow(projectId, blockId);

    const block = await this.prisma.client.buildingBlock.update({
      where: { id: blockId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
    return this.toResponse(block);
  }

  /**
   * The Phase 3 §14 guard: a `blockId` that exists but belongs to a
   * *different* project is treated identically to one that doesn't exist at
   * all — both 404. The caller's authorization for `projectId` itself was
   * already established by `assertAccess` before this runs; this only
   * confirms the nested resource actually lives inside that already-
   * authorized project, so no existence of another project's data leaks.
   */
  async getBlockOrThrow(
    projectId: string,
    blockId: string,
  ): Promise<BuildingBlock> {
    const block = await this.prisma.client.buildingBlock.findFirst({
      where: { id: blockId, projectId },
    });
    if (!block) {
      throw new NotFoundException({
        code: 'BLOCK_PROJECT_MISMATCH',
        message: 'Building block not found in this project',
      });
    }
    return block;
  }

  private toResponse(block: BuildingBlock): BuildingBlockResponseDto {
    return {
      id: block.id,
      projectId: block.projectId,
      name: block.name,
      code: block.code,
      isActive: block.isActive,
      createdAt: block.createdAt,
    };
  }
}
