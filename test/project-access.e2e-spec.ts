import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigModule } from '../src/config/config.module.js';
import { PrismaModule } from '../src/database/prisma.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Role } from '../src/generated/prisma/client.js';
import { AuthenticatedUser } from '../src/modules/auth/types/authenticated-user.js';
import { ProjectAccessAction } from '../src/modules/projects/project-access-action.enum.js';
import { ProjectAccessService } from '../src/modules/projects/project-access.service.js';
import {
  createTestProject,
  deleteTestProject,
} from './fixtures/auth.fixture.js';

/**
 * The Phase 3+ authorization foundation (docs/backend-architecture.md
 * §13/§14), tested against a real `Project` row in real PostgreSQL rather
 * than a mocked Prisma client — this is exactly the kind of "real, not
 * placeholder" logic docs/backend-architecture.md §12 asks for, even though
 * no controller calls it yet.
 */
describe('ProjectAccessService (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let service: ProjectAccessService;
  let project: { id: string };
  let otherProject: { id: string };

  function user(overrides: Partial<AuthenticatedUser>): AuthenticatedUser {
    return {
      id: randomUUID(),
      email: 'x@example.com',
      displayName: 'X',
      role: Role.OWNER,
      projectId: null,
      sessionId: randomUUID(),
      ...overrides,
    };
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, PrismaModule],
      providers: [ProjectAccessService],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(ProjectAccessService);
    project = await createTestProject(prisma.client, 'Access Test Project');
    otherProject = await createTestProject(prisma.client, 'Other Project');
  });

  afterAll(async () => {
    await deleteTestProject(prisma.client, project.id);
    await deleteTestProject(prisma.client, otherProject.id);
    await moduleRef.close();
  });

  describe('OWNER / ACCOUNTANT', () => {
    it('may read any active project', async () => {
      const owner = user({ role: Role.OWNER });
      const result = await service.assertAccess(
        owner,
        project.id,
        ProjectAccessAction.READ,
      );
      expect(result.id).toBe(project.id);

      const accountant = user({ role: Role.ACCOUNTANT });
      await expect(
        service.assertAccess(
          accountant,
          otherProject.id,
          ProjectAccessAction.READ,
        ),
      ).resolves.toMatchObject({ id: otherProject.id });
    });

    it('may never write, to any project', async () => {
      const owner = user({ role: Role.OWNER });
      await expect(
        service.assertAccess(owner, project.id, ProjectAccessAction.WRITE),
      ).rejects.toMatchObject({ response: { code: 'PROJECT_ACCESS_DENIED' } });

      const accountant = user({ role: Role.ACCOUNTANT });
      await expect(
        service.assertAccess(accountant, project.id, ProjectAccessAction.WRITE),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns 404 (not 403) for a nonexistent project on a read they are otherwise allowed', async () => {
      const owner = user({ role: Role.OWNER });
      await expect(
        service.assertAccess(owner, randomUUID(), ProjectAccessAction.READ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('PROJECT_MANAGER', () => {
    it('may read and write only their own assigned project', async () => {
      const manager = user({
        role: Role.PROJECT_MANAGER,
        projectId: project.id,
      });
      await expect(
        service.assertAccess(manager, project.id, ProjectAccessAction.READ),
      ).resolves.toMatchObject({ id: project.id });
      await expect(
        service.assertAccess(manager, project.id, ProjectAccessAction.WRITE),
      ).resolves.toMatchObject({ id: project.id });
    });

    it('is denied — with PROJECT_ACCESS_DENIED, not merely NOT_FOUND — for any other project, even to just read', async () => {
      const manager = user({
        role: Role.PROJECT_MANAGER,
        projectId: project.id,
      });
      await expect(
        service.assertAccess(
          manager,
          otherProject.id,
          ProjectAccessAction.READ,
        ),
      ).rejects.toMatchObject({ response: { code: 'PROJECT_ACCESS_DENIED' } });
      await expect(
        service.assertAccess(
          manager,
          otherProject.id,
          ProjectAccessAction.WRITE,
        ),
      ).rejects.toMatchObject({ response: { code: 'PROJECT_ACCESS_DENIED' } });
    });

    it('cannot use a manipulated/foreign projectId to probe existence of a project outside their authority', async () => {
      // A nonexistent project ID outside the manager's authority must still
      // be 403, not 404 — a 404 here would leak "this ID doesn't exist" to
      // someone not authorized to know about it at all.
      const manager = user({
        role: Role.PROJECT_MANAGER,
        projectId: project.id,
      });
      const response = await service
        .assertAccess(manager, randomUUID(), ProjectAccessAction.READ)
        .catch((error: ForbiddenException) => error);
      expect(response).toBeInstanceOf(ForbiddenException);
    });
  });

  it('rejects access to an inactive project even for an otherwise-authorized manager', async () => {
    const inactiveProject = await prisma.client.project.create({
      data: {
        name: 'Inactive',
        code: `inactive-${randomUUID()}`,
        isActive: false,
      },
    });
    try {
      const manager = user({
        role: Role.PROJECT_MANAGER,
        projectId: inactiveProject.id,
      });
      await expect(
        service.assertAccess(
          manager,
          inactiveProject.id,
          ProjectAccessAction.READ,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await deleteTestProject(prisma.client, inactiveProject.id);
    }
  });
});
