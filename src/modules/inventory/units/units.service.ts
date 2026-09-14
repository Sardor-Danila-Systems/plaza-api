import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service.js';
import { Unit } from '../../../generated/prisma/client.js';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { ProjectAccessAction } from '../../projects/project-access-action.enum.js';
import { ProjectAccessService } from '../../projects/project-access.service.js';
import { UnitResponseDto } from './dto/unit-response.dto.js';

/**
 * Read-only (this phase's §22): units are project-scoped
 * (docs/backend-data-model.md — "seeded project rows such as kg, bag, m²",
 * not a global/system table) but closer to reference configuration than
 * operational content, so there is no PROJECT_MANAGER creation endpoint —
 * only `prisma/seed.ts` provisions them, the same posture Phase 4 gave
 * TransactionCategory's seeded defaults before managers could add more;
 * units simply never gained that "manager may add more" extension here.
 */
@Injectable()
export class UnitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
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
