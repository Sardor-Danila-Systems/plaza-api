import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Project, Role } from '../../generated/prisma/client.js';

/**
 * Project creation and manager assignment/role changes — invoked only by
 * `src/cli/provision.ts` (and `prisma/seed.ts` for dev data), never by an
 * HTTP controller. See ADR 0014 for why this stays outside the authenticated
 * business API entirely, and ADR 0013 for the reassignment mechanism below.
 */
@Injectable()
export class ProjectProvisioningService {
  constructor(private readonly prisma: PrismaService) {}

  async createProject(input: {
    name: string;
    code: string;
    timezone?: string;
  }): Promise<Project> {
    return this.prisma.client.project.create({
      data: {
        name: input.name,
        code: input.code,
        ...(input.timezone ? { timezone: input.timezone } : {}),
      },
    });
  }

  /**
   * Renames a project. Phase 3.1 correction: this was originally exposed as
   * a manager-writable `PATCH /projects/:projectId` — removed because
   * "PROJECT_MANAGER may operate on their project's content" does not imply
   * "may change the project's own administrative identity." `code` and
   * `timezone` are deliberately not editable here either (stable
   * identifiers/config, not something this method's callers have asked to
   * change) — extend this service with a dedicated method if that need is
   * ever approved, rather than adding a generic `updateProject`.
   */
  async renameProject(projectId: string, name: string): Promise<Project> {
    const project = await this.prisma.client.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    return this.prisma.client.project.update({
      where: { id: projectId },
      data: { name },
    });
  }

  /**
   * Assigns `userId` as the active PROJECT_MANAGER of `projectId`, atomically
   * displacing whoever currently holds it (deactivating them — their
   * historical `projectId`/`role` are never rewritten, per ADR 0013). Also
   * the correct call for "promote this ACCOUNTANT/OWNER to manage a
   * project" — it unconditionally sets `role = PROJECT_MANAGER` regardless
   * of the target's prior role. If `userId` already manages a *different*
   * project, they stop managing it (a manager belongs to exactly one
   * project) — an intended consequence, not a bug.
   *
   * The transaction's statement order matters: the outgoing manager is
   * deactivated *before* the incoming manager is activated, so at no point
   * does this transaction attempt to hold two active managers for the same
   * project (PostgreSQL does not defer a plain unique/partial index, so the
   * reverse order would simply fail). Two concurrent calls targeting the
   * same project are still safe even so — the database's partial unique
   * index (see the Phase 3 migration) is the final backstop that lets only
   * one of them commit; the loser's transaction rolls back entirely.
   */
  async assignManager(projectId: string, userId: string): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      const project = await tx.project.findUnique({ where: { id: projectId } });
      if (!project) {
        throw new NotFoundException(`Project ${projectId} not found`);
      }
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) {
        throw new NotFoundException(`User ${userId} not found`);
      }

      await tx.user.updateMany({
        where: {
          projectId,
          role: Role.PROJECT_MANAGER,
          isActive: true,
          NOT: { id: userId },
        },
        data: { isActive: false },
      });

      await tx.user.update({
        where: { id: userId },
        data: { role: Role.PROJECT_MANAGER, projectId, isActive: true },
      });
    });
  }

  /**
   * Changes a user's role. PROJECT_MANAGER requires (and delegates entirely
   * to) `assignManager`; OWNER/ACCOUNTANT clear `projectId`. Rejects an
   * inconsistent combination before writing anything — the CHECK constraint
   * would also catch it, but this gives a readable operator-facing error
   * instead of a raw constraint-violation message.
   */
  async setRole(userId: string, role: Role, projectId?: string): Promise<void> {
    if (role === Role.PROJECT_MANAGER) {
      if (!projectId) {
        throw new BadRequestException(
          'projectId is required when role is PROJECT_MANAGER',
        );
      }
      await this.assignManager(projectId, userId);
      return;
    }

    if (projectId) {
      throw new BadRequestException(
        `projectId must not be supplied when role is ${role}`,
      );
    }

    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    await this.prisma.client.user.update({
      where: { id: userId },
      data: { role, projectId: null },
    });
  }
}
