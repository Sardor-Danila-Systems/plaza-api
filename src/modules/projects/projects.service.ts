import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Project, Role, User } from '../../generated/prisma/client.js';
import { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { ProjectAccessAction } from './project-access-action.enum.js';
import { ProjectAccessService } from './project-access.service.js';
import { ProjectResponseDto } from './dto/project-response.dto.js';

/** The one filter clause that fetches "the" active manager for a project —
 * at most one row can ever match, enforced by the partial unique index in
 * the Phase 3 migration (see docs/adr/0013-project-manager-relation.md). */
const ACTIVE_MANAGER_FILTER = {
  role: Role.PROJECT_MANAGER,
  isActive: true,
} as const;

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  /**
   * Database-filtered by role (Phase 3 §25) — never "fetch everything, then
   * filter in JavaScript". A PROJECT_MANAGER's query can only ever match
   * their own project (or nothing, if unassigned — never happens for an
   * authenticated PROJECT_MANAGER given the CHECK constraint, but the query
   * degrades safely either way).
   */
  async listForUser(user: AuthenticatedUser): Promise<ProjectResponseDto[]> {
    const where =
      user.role === Role.PROJECT_MANAGER
        ? { id: user.projectId ?? '', isActive: true }
        : { isActive: true };

    const projects = await this.prisma.client.project.findMany({
      where,
      include: { managers: { where: ACTIVE_MANAGER_FILTER, take: 1 } },
      orderBy: { name: 'asc' },
    });

    return projects.map((project) =>
      this.toResponse(project, project.managers[0] ?? null),
    );
  }

  async getForUser(
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<ProjectResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );

    // assertAccess already proved this project exists and is authorized for
    // this caller; re-fetching with the manager relation here (rather than
    // threading it through assertAccess's return type) keeps
    // ProjectAccessService focused purely on authorization, not response
    // shaping — see its own doc comment.
    const manager = await this.prisma.client.user.findFirst({
      where: { projectId, ...ACTIVE_MANAGER_FILTER },
    });
    const project = await this.prisma.client.project.findUniqueOrThrow({
      where: { id: projectId },
    });

    return this.toResponse(project, manager);
  }

  private toResponse(
    project: Project,
    manager: User | null,
  ): ProjectResponseDto {
    return {
      id: project.id,
      name: project.name,
      code: project.code,
      timezone: project.timezone,
      isActive: project.isActive,
      manager: manager
        ? {
            id: manager.id,
            displayName: manager.displayName,
            email: manager.email,
          }
        : null,
      createdAt: project.createdAt,
    };
  }
}
