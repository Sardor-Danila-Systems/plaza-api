import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service.js';
import { Floor, Prisma } from '../../../generated/prisma/client.js';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { ProjectAccessAction } from '../../projects/project-access-action.enum.js';
import { ProjectAccessService } from '../../projects/project-access.service.js';
import { BlocksService } from '../blocks/blocks.service.js';
import { CreateFloorDto } from './dto/create-floor.dto.js';
import { CreateFloorsBulkDto } from './dto/create-floors-bulk.dto.js';
import { FloorResponseDto } from './dto/floor-response.dto.js';
import { UpdateFloorDto } from './dto/update-floor.dto.js';

@Injectable()
export class FloorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly blocksService: BlocksService,
  ) {}

  async list(
    user: AuthenticatedUser,
    projectId: string,
    blockId: string,
  ): Promise<FloorResponseDto[]> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    await this.blocksService.getBlockOrThrow(projectId, blockId);

    const floors = await this.prisma.client.floor.findMany({
      where: { projectId, blockId },
      orderBy: { sortOrder: 'asc' },
    });
    return floors.map(this.toResponse);
  }

  async get(
    user: AuthenticatedUser,
    projectId: string,
    blockId: string,
    floorId: string,
  ): Promise<FloorResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    await this.blocksService.getBlockOrThrow(projectId, blockId);
    const floor = await this.getFloorOrThrow(projectId, blockId, floorId);
    return this.toResponse(floor);
  }

  async create(
    user: AuthenticatedUser,
    projectId: string,
    blockId: string,
    dto: CreateFloorDto,
  ): Promise<FloorResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.WRITE,
    );
    await this.blocksService.getBlockOrThrow(projectId, blockId);

    const floor = await this.prisma.client.floor.create({
      data: { projectId, blockId, label: dto.label, sortOrder: dto.sortOrder },
    });
    return this.toResponse(floor);
  }

  /**
   * All-or-nothing bulk add. `sortOrder` continues after the block's
   * current highest by default, so repeated calls keep stacking floors in
   * the order they were added instead of colliding at 0.
   */
  async createBulk(
    user: AuthenticatedUser,
    projectId: string,
    blockId: string,
    dto: CreateFloorsBulkDto,
  ): Promise<FloorResponseDto[]> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.WRITE,
    );
    await this.blocksService.getBlockOrThrow(projectId, blockId);

    let start = dto.startSortOrder;
    if (start === undefined) {
      const highest = await this.prisma.client.floor.findFirst({
        where: { projectId, blockId },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      start = highest ? highest.sortOrder + 1 : 1;
    }

    try {
      const floors = await this.prisma.client.$transaction(
        dto.labels.map((label, index) =>
          this.prisma.client.floor.create({
            data: { projectId, blockId, label, sortOrder: start + index },
          }),
        ),
      );
      return floors.map(this.toResponse);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'FLOOR_LABEL_TAKEN',
          message:
            'One of these floor labels already exists in this building block',
        });
      }
      throw error;
    }
  }

  async update(
    user: AuthenticatedUser,
    projectId: string,
    blockId: string,
    floorId: string,
    dto: UpdateFloorDto,
  ): Promise<FloorResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.WRITE,
    );
    await this.blocksService.getBlockOrThrow(projectId, blockId);
    await this.getFloorOrThrow(projectId, blockId, floorId);

    const floor = await this.prisma.client.floor.update({
      where: { id: floorId },
      data: {
        ...(dto.label !== undefined ? { label: dto.label } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
    return this.toResponse(floor);
  }

  /**
   * Two distinct 404s (Phase 3 §14): a floor missing from the project
   * entirely (`FLOOR_PROJECT_MISMATCH`) versus one that exists in this
   * project but under a *different* block than the URL's `blockId`
   * (`FLOOR_BLOCK_MISMATCH`). Both are checked only after the caller's
   * project-level and block-level authorization already passed, so neither
   * leaks anything about data outside the caller's authorized project.
   */
  private async getFloorOrThrow(
    projectId: string,
    blockId: string,
    floorId: string,
  ): Promise<Floor> {
    const floor = await this.prisma.client.floor.findFirst({
      where: { id: floorId, projectId },
    });
    if (!floor) {
      throw new NotFoundException({
        code: 'FLOOR_PROJECT_MISMATCH',
        message: 'Floor not found in this project',
      });
    }
    if (floor.blockId !== blockId) {
      throw new NotFoundException({
        code: 'FLOOR_BLOCK_MISMATCH',
        message: 'Floor does not belong to this building block',
      });
    }
    return floor;
  }

  private toResponse(floor: Floor): FloorResponseDto {
    return {
      id: floor.id,
      projectId: floor.projectId,
      blockId: floor.blockId,
      label: floor.label,
      sortOrder: floor.sortOrder,
      isActive: floor.isActive,
      createdAt: floor.createdAt,
    };
  }
}
