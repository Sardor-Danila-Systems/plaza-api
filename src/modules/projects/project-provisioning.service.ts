import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PrismaService } from '../../database/prisma.service.js';
import { normalizeEmail } from '../auth/email-normalization.js';
import { PasswordService } from '../auth/password.service.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { Prisma, Project, Role, User } from '../../generated/prisma/client.js';

/**
 * Project creation and manager assignment/role changes — invoked only by
 * `src/cli/provision.ts` (and `prisma/seed.ts` for dev data), never by an
 * HTTP controller. See ADR 0014 for why this stays outside the authenticated
 * business API entirely, and ADR 0013 for the reassignment mechanism below.
 */
@Injectable()
export class ProjectProvisioningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
  ) {}

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

  /**
   * Creates a new user account — the production-safe replacement for
   * `prisma/seed.ts` (which refuses `NODE_ENV=production`) and the only way
   * to provision the very first accounts, since there is no self-registration
   * endpoint (ADR 0014/0015 apply here too: only `src/cli/provision.ts`
   * calls this, never a controller). Accepts exactly the fields a CLI
   * operator can pass — `email`, `displayName`, `password`, `role`, and
   * `projectId` — nothing else about the row (isActive, timestamps, id) is
   * caller-controlled.
   *
   * Input is validated with the same standalone class-validator pattern
   * `env.validation.ts` uses (see CreateUserDto). Never returns or logs
   * `passwordHash`.
   */
  async createUser(input: {
    email: string;
    displayName: string;
    password: string;
    role: Role;
    projectId?: string;
  }): Promise<Omit<User, 'passwordHash'>> {
    const dto = plainToInstance(CreateUserDto, input);
    const errors = validateSync(dto, { skipMissingProperties: false });
    if (errors.length > 0) {
      const details = errors
        .map((error) => Object.values(error.constraints ?? {}).join('; '))
        .join('\n');
      throw new BadRequestException(`Invalid user input:\n${details}`);
    }

    if (dto.role === Role.PROJECT_MANAGER) {
      if (!dto.projectId) {
        throw new BadRequestException(
          'projectId is required when role is PROJECT_MANAGER',
        );
      }
    } else if (dto.projectId) {
      throw new BadRequestException(
        `projectId must not be supplied when role is ${dto.role}`,
      );
    }

    const email = normalizeEmail(dto.email);
    const passwordHash = await this.passwordService.hash(dto.password);

    let user: User;
    try {
      user = await this.prisma.client.$transaction(async (tx) => {
        if (dto.role === Role.PROJECT_MANAGER) {
          const project = await tx.project.findUnique({
            where: { id: dto.projectId },
          });
          if (!project) {
            throw new NotFoundException(`Project ${dto.projectId} not found`);
          }
          // Same invariant-preserving statement order as assignManager
          // (see its doc comment): deactivate any existing active manager
          // of this project BEFORE creating the new active manager row —
          // the partial unique index (User_one_active_manager_per_project)
          // is not deferrable.
          await tx.user.updateMany({
            where: {
              projectId: dto.projectId,
              role: Role.PROJECT_MANAGER,
              isActive: true,
            },
            data: { isActive: false },
          });
        }

        return tx.user.create({
          data: {
            email,
            displayName: dto.displayName,
            role: dto.role,
            passwordHash,
            projectId:
              dto.role === Role.PROJECT_MANAGER ? dto.projectId! : null,
          },
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          `A user with email "${email}" already exists`,
        );
      }
      throw error;
    }

    const { passwordHash: _passwordHash, ...safeUser } = user;
    return safeUser;
  }
}
