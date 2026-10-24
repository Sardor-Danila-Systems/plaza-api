import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service.js';
import { Prisma, Unit } from '../../../generated/prisma/client.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { ProjectAccessAction } from '../../projects/project-access-action.enum.js';
import { ProjectAccessService } from '../../projects/project-access.service.js';
import { CreateUnitDto } from './dto/create-unit.dto.js';
import { UnitResponseDto } from './dto/unit-response.dto.js';

/**
 * Units are project-scoped (docs/backend-data-model.md — "seeded project
 * rows such as kg, bag, m²", not a global/system table). `prisma/seed.ts`
 * provisions the standard set; managers can add more via `POST` so a new
 * material is never blocked on a missing unit. No update/delete: a Material's
 * `unitId` is immutable, so renaming a unit would silently change history.
 */
@Injectable()
export class UnitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly audit: AuditService,
  ) {}

  async list(
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<UnitResponseDto[]> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    const units = await this.prisma.client.unit.findMany({
      where: { projectId },
      orderBy: { name: 'asc' },
    });
    return units.map(this.toResponse);
  }

  async create(
    user: AuthenticatedUser,
    projectId: string,
    dto: CreateUnitDto,
    requestId?: string,
  ): Promise<UnitResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.WRITE,
    );

    let unit: Unit;
    try {
      unit = await this.prisma.client.unit.create({
        data: {
          projectId,
          name: dto.name.trim(),
          symbol: dto.symbol.trim(),
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'UNIQUE_CONSTRAINT_VIOLATION',
          message: `A unit with symbol "${dto.symbol}" already exists in this project`,
        });
      }
      throw error;
    }

    await this.prisma.client.$transaction(async (tx) => {
      await this.audit.record(tx, {
        projectId,
        actorId: user.id,
        action: 'unit.create',
        entityType: 'Unit',
        entityId: unit.id,
        requestId,
        newData: { ...this.toResponse(unit) },
      });
    });

    return this.toResponse(unit);
  }

  private toResponse(unit: Unit): UnitResponseDto {
    return {
      id: unit.id,
      projectId: unit.projectId,
      name: unit.name,
      symbol: unit.symbol,
      isActive: unit.isActive,
      createdAt: unit.createdAt,
    };
  }
}
