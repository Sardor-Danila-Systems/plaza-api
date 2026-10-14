import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaTx } from '../../database/project-lock.service.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Project, Role, User } from '../../generated/prisma/client.js';
import { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { ProjectAccessAction } from './project-access-action.enum.js';
import { ProjectAccessArea } from './project-access-area.enum.js';

/**
 * The Phase 3+ authorization primitive for every project-scoped resource
 * (docs/backend-architecture.md §13/§14). Phase 2 wires this up completely
 * and for real against the minimal `Project` table (see prisma/schema.prisma)
 * — there is no placeholder/fake logic here for Phase 3 to "complete"; Phase
 * 3 only needs to call `assertAccess` before its own business reads/writes.
 *
 * Policy:
 * - OWNER / ACCOUNTANT: READ any active project, WRITE none.
 * - PROJECT_MANAGER: READ/WRITE only their own assigned (active) project.
 * - CASHIER: READ/WRITE only their own assigned project, and only in
 *   `ProjectAccessArea.CASH` — denied everywhere else (see that enum).
 * - DEVELOPER: READ/WRITE any project, in every area.
 *
 * Authorization is checked BEFORE existence: a request for a project outside
 * the caller's authority returns 403 `PROJECT_ACCESS_DENIED` whether or not
 * that project exists (never let a 404-vs-403 difference leak which project
 * IDs are real to someone who isn't authorized to know). Only a request that
 * passes authorization but targets a nonexistent/inactive project returns
 * 404 (docs/backend-architecture.md §9).
 */
@Injectable()
export class ProjectAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async assertAccess(
    user: AuthenticatedUser,
    projectId: string,
    action: ProjectAccessAction,
    area: ProjectAccessArea = ProjectAccessArea.GENERAL,
  ): Promise<Project> {
    this.assertPolicy(user.role, user.projectId, projectId, action, area);

    const project = await this.prisma.client.project.findUnique({
      where: { id: projectId },
    });
    if (!project || !project.isActive) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Project not found',
      });
    }

    return project;
  }

  /**
   * The project-lock-protocol variant of `assertAccess` (transaction-design.md
   * §1 step 3): re-validates the actor's role/project assignment against the
   * database INSIDE an already-open project-lock transaction, never trusting
   * the `AuthenticatedUser` object carried on the request. `JwtAuthGuard`
   * already re-loads the actor once per request (ADR 0009), but that happens
   * *before* this transaction begins — a concurrent CLI reassignment or
   * deactivation landing in the gap between that check and this transaction
   * acquiring its lock must still be caught, which is exactly what re-reading
   * the actor fresh via `tx` accomplishes. Every retry attempt calls this
   * again with a fresh `tx`, so a change that lands between attempts is also
   * caught, not just one made before the first attempt.
   *
   * Same authorization policy and error shapes as `assertAccess`; additionally
   * treats a since-deactivated actor as access-denied (rather than some other
   * error) — from the caller's perspective it is still simply "you do not
   * have access", and revealing *why* would leak account-state information
   * to a request that should never have reached this far in the first place.
   */
  async assertAccessInTransaction(
    tx: PrismaTx,
    actorId: string,
    projectId: string,
    action: ProjectAccessAction,
    area: ProjectAccessArea = ProjectAccessArea.GENERAL,
  ): Promise<{ project: Project; actor: User }> {
    const actor = await tx.user.findUnique({ where: { id: actorId } });
    if (!actor || !actor.isActive) {
      throw this.accessDenied();
    }

    this.assertPolicy(actor.role, actor.projectId, projectId, action, area);

    const project = await tx.project.findUnique({ where: { id: projectId } });
    if (!project || !project.isActive) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Project not found',
      });
    }

    return { project, actor };
  }

  /** The one place the role/project/action/area policy lives, shared by
   * both entry points so the request-time and in-transaction checks can
   * never drift apart. */
  private assertPolicy(
    role: Role,
    assignedProjectId: string | null,
    projectId: string,
    action: ProjectAccessAction,
    area: ProjectAccessArea,
  ): void {
    switch (role) {
      case Role.PROJECT_MANAGER:
        if (assignedProjectId !== projectId) throw this.accessDenied();
        return;
      case Role.CASHIER:
        if (assignedProjectId !== projectId) throw this.accessDenied();
        if (area !== ProjectAccessArea.CASH) throw this.accessDenied();
        return;
      case Role.DEVELOPER:
        return;
      case Role.OWNER:
      case Role.ACCOUNTANT:
        // Read anything, write nothing, regardless of which project.
        if (action === ProjectAccessAction.WRITE) throw this.accessDenied();
        return;
    }
  }

  private accessDenied(): ForbiddenException {
    return new ForbiddenException({
      code: 'PROJECT_ACCESS_DENIED',
      message: 'You do not have access to this project',
    });
  }
}
