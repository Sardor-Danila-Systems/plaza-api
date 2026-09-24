import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigModule } from '../src/config/config.module.js';
import { PrismaModule } from '../src/database/prisma.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Role } from '../src/generated/prisma/client.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { ProjectProvisioningService } from '../src/modules/projects/project-provisioning.service.js';
import {
  createTestProject,
  createTestUser,
  deleteTestProject,
  deleteTestUser,
} from './fixtures/auth.fixture.js';

/**
 * Real PostgreSQL throughout (docs/backend-architecture.md §12) — this is
 * exactly where a mocked Prisma client could hide a real constraint-
 * violation or race-condition bug.
 */
describe('ProjectProvisioningService (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let provisioning: ProjectProvisioningService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, PrismaModule],
      providers: [ProjectProvisioningService, PasswordService],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    provisioning = moduleRef.get(ProjectProvisioningService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  describe('createProject', () => {
    it('creates a project with the default timezone', async () => {
      const project = await provisioning.createProject({
        name: 'Test Project',
        code: `test-${randomUUID()}`,
      });
      try {
        expect(project.timezone).toBe('Asia/Samarkand');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });

  describe('renameProject (Phase 3.1: the only way to rename a project)', () => {
    it('renames a project', async () => {
      const project = await createTestProject(prisma.client, 'Old Name');
      try {
        const renamed = await provisioning.renameProject(
          project.id,
          'New Name',
        );
        expect(renamed.name).toBe('New Name');
        const persisted = await prisma.client.project.findUniqueOrThrow({
          where: { id: project.id },
        });
        expect(persisted.name).toBe('New Name');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('throws for a nonexistent project', async () => {
      await expect(
        provisioning.renameProject(randomUUID(), 'X'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('assignManager', () => {
    it('promotes an ACCOUNTANT to PROJECT_MANAGER of a project', async () => {
      const project = await createTestProject(prisma.client);
      const user = await createTestUser(prisma.client, {
        role: Role.ACCOUNTANT,
      });
      try {
        await provisioning.assignManager(project.id, user.id);
        const updated = await prisma.client.user.findUniqueOrThrow({
          where: { id: user.id },
        });
        expect(updated.role).toBe(Role.PROJECT_MANAGER);
        expect(updated.projectId).toBe(project.id);
        expect(updated.isActive).toBe(true);
      } finally {
        await deleteTestUser(prisma.client, user.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('reassignment deactivates the outgoing manager WITHOUT clearing their historical projectId', async () => {
      const project = await createTestProject(prisma.client);
      const managerA = await createTestUser(prisma.client, {
        role: Role.PROJECT_MANAGER,
        projectId: project.id,
      });
      const managerB = await createTestUser(prisma.client, {
        role: Role.ACCOUNTANT,
      });

      try {
        await provisioning.assignManager(project.id, managerB.id);

        const a = await prisma.client.user.findUniqueOrThrow({
          where: { id: managerA.id },
        });
        expect(a.isActive).toBe(false);
        expect(a.role).toBe(Role.PROJECT_MANAGER); // history preserved, never rewritten
        expect(a.projectId).toBe(project.id); // history preserved, never nulled

        const b = await prisma.client.user.findUniqueOrThrow({
          where: { id: managerB.id },
        });
        expect(b.isActive).toBe(true);
        expect(b.role).toBe(Role.PROJECT_MANAGER);
        expect(b.projectId).toBe(project.id);
      } finally {
        await deleteTestUser(prisma.client, managerA.id);
        await deleteTestUser(prisma.client, managerB.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('moving a manager to a new project removes them from the old one (a manager belongs to exactly one project)', async () => {
      const projectA = await createTestProject(prisma.client, 'A');
      const projectB = await createTestProject(prisma.client, 'B');
      const manager = await createTestUser(prisma.client, {
        role: Role.PROJECT_MANAGER,
        projectId: projectA.id,
      });

      try {
        await provisioning.assignManager(projectB.id, manager.id);
        const updated = await prisma.client.user.findUniqueOrThrow({
          where: { id: manager.id },
        });
        expect(updated.projectId).toBe(projectB.id);

        // Project A now has no active manager.
        const activeManagerOfA = await prisma.client.user.findFirst({
          where: {
            projectId: projectA.id,
            role: Role.PROJECT_MANAGER,
            isActive: true,
          },
        });
        expect(activeManagerOfA).toBeNull();
      } finally {
        await deleteTestUser(prisma.client, manager.id);
        await deleteTestProject(prisma.client, projectA.id);
        await deleteTestProject(prisma.client, projectB.id);
      }
    });

    it('throws for a nonexistent project', async () => {
      const user = await createTestUser(prisma.client, {
        role: Role.ACCOUNTANT,
      });
      try {
        await expect(
          provisioning.assignManager(randomUUID(), user.id),
        ).rejects.toBeInstanceOf(NotFoundException);
      } finally {
        await deleteTestUser(prisma.client, user.id);
      }
    });

    it('throws for a nonexistent user', async () => {
      const project = await createTestProject(prisma.client);
      try {
        await expect(
          provisioning.assignManager(project.id, randomUUID()),
        ).rejects.toBeInstanceOf(NotFoundException);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('two concurrent assignments to the same project: exactly one wins, database ends in a valid state', async () => {
      const project = await createTestProject(prisma.client);
      const candidateA = await createTestUser(prisma.client, {
        role: Role.ACCOUNTANT,
      });
      const candidateB = await createTestUser(prisma.client, {
        role: Role.ACCOUNTANT,
      });

      try {
        const results = await Promise.allSettled([
          provisioning.assignManager(project.id, candidateA.id),
          provisioning.assignManager(project.id, candidateB.id),
        ]);

        // Both may report success from the application's point of view (each
        // transaction saw no active manager to displace and proceeded) —
        // what matters is the DATABASE's final state, which the partial
        // unique index guarantees is never two active managers for one
        // project, per docs/adr/0013-project-manager-relation.md.
        const activeManagers = await prisma.client.user.findMany({
          where: {
            projectId: project.id,
            role: Role.PROJECT_MANAGER,
            isActive: true,
          },
        });
        expect(activeManagers).toHaveLength(1);
        expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      } finally {
        await deleteTestUser(prisma.client, candidateA.id);
        await deleteTestUser(prisma.client, candidateB.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });

  describe('setRole', () => {
    it('PROJECT_MANAGER -> ACCOUNTANT clears projectId atomically', async () => {
      const project = await createTestProject(prisma.client);
      const manager = await createTestUser(prisma.client, {
        role: Role.PROJECT_MANAGER,
        projectId: project.id,
      });
      try {
        await provisioning.setRole(manager.id, Role.ACCOUNTANT);
        const updated = await prisma.client.user.findUniqueOrThrow({
          where: { id: manager.id },
        });
        expect(updated.role).toBe(Role.ACCOUNTANT);
        expect(updated.projectId).toBeNull();
      } finally {
        await deleteTestUser(prisma.client, manager.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('ACCOUNTANT -> PROJECT_MANAGER requires a projectId', async () => {
      const user = await createTestUser(prisma.client, {
        role: Role.ACCOUNTANT,
      });
      try {
        await expect(
          provisioning.setRole(user.id, Role.PROJECT_MANAGER),
        ).rejects.toBeInstanceOf(BadRequestException);
      } finally {
        await deleteTestUser(prisma.client, user.id);
      }
    });

    it('rejects supplying a projectId for a non-manager role', async () => {
      const project = await createTestProject(prisma.client);
      const user = await createTestUser(prisma.client, {
        role: Role.ACCOUNTANT,
      });
      try {
        await expect(
          provisioning.setRole(user.id, Role.OWNER, project.id),
        ).rejects.toBeInstanceOf(BadRequestException);
      } finally {
        await deleteTestUser(prisma.client, user.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('never leaves a partially-updated state on rejection (no role/projectId change persisted)', async () => {
      const user = await createTestUser(prisma.client, {
        role: Role.ACCOUNTANT,
      });
      try {
        await expect(
          provisioning.setRole(user.id, Role.PROJECT_MANAGER),
        ).rejects.toThrow();
        const unchanged = await prisma.client.user.findUniqueOrThrow({
          where: { id: user.id },
        });
        expect(unchanged.role).toBe(Role.ACCOUNTANT);
        expect(unchanged.projectId).toBeNull();
      } finally {
        await deleteTestUser(prisma.client, user.id);
      }
    });
  });

  describe('createUser', () => {
    const VALID_PASSWORD = 'a-perfectly-fine-password-1234';
    let passwordService: PasswordService;

    beforeAll(() => {
      passwordService = moduleRef.get(PasswordService);
    });

    it('creates an OWNER with no projectId and never returns passwordHash', async () => {
      const email = `owner-${randomUUID()}@example.com`;
      const user = await provisioning.createUser({
        email,
        displayName: 'New Owner',
        password: VALID_PASSWORD,
        role: Role.OWNER,
      });
      try {
        expect(user.email).toBe(email);
        expect(user.role).toBe(Role.OWNER);
        expect(user.projectId).toBeNull();
        expect(user.isActive).toBe(true);
        expect(user).not.toHaveProperty('passwordHash');

        const persisted = await prisma.client.user.findUniqueOrThrow({
          where: { id: user.id },
        });
        const verified = await passwordService.verify(
          persisted.passwordHash,
          VALID_PASSWORD,
        );
        expect(verified).toBe(true);
      } finally {
        await deleteTestUser(prisma.client, user.id);
      }
    });

    it('creates an ACCOUNTANT with no projectId', async () => {
      const email = `accountant-${randomUUID()}@example.com`;
      const user = await provisioning.createUser({
        email,
        displayName: 'New Accountant',
        password: VALID_PASSWORD,
        role: Role.ACCOUNTANT,
      });
      try {
        expect(user.role).toBe(Role.ACCOUNTANT);
        expect(user.projectId).toBeNull();
      } finally {
        await deleteTestUser(prisma.client, user.id);
      }
    });

    it('normalizes email to lowercase/trimmed', async () => {
      const suffix = randomUUID();
      const user = await provisioning.createUser({
        email: `  Mixed-Case-${suffix}@Example.com  `,
        displayName: 'Case Test',
        password: VALID_PASSWORD,
        role: Role.OWNER,
      });
      try {
        expect(user.email).toBe(`mixed-case-${suffix}@example.com`);
      } finally {
        await deleteTestUser(prisma.client, user.id);
      }
    });

    it('creates a PROJECT_MANAGER with the given projectId, active', async () => {
      const project = await createTestProject(prisma.client);
      const user = await provisioning.createUser({
        email: `pm-${randomUUID()}@example.com`,
        displayName: 'New PM',
        password: VALID_PASSWORD,
        role: Role.PROJECT_MANAGER,
        projectId: project.id,
      });
      try {
        expect(user.role).toBe(Role.PROJECT_MANAGER);
        expect(user.projectId).toBe(project.id);
        expect(user.isActive).toBe(true);
      } finally {
        await deleteTestUser(prisma.client, user.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it("creating a PROJECT_MANAGER deactivates the project's existing active manager (same invariant as assignManager)", async () => {
      const project = await createTestProject(prisma.client);
      const existingManager = await createTestUser(prisma.client, {
        role: Role.PROJECT_MANAGER,
        projectId: project.id,
      });
      const newManager = await provisioning.createUser({
        email: `pm2-${randomUUID()}@example.com`,
        displayName: 'Replacement PM',
        password: VALID_PASSWORD,
        role: Role.PROJECT_MANAGER,
        projectId: project.id,
      });
      try {
        const outgoing = await prisma.client.user.findUniqueOrThrow({
          where: { id: existingManager.id },
        });
        expect(outgoing.isActive).toBe(false);

        const activeManagers = await prisma.client.user.findMany({
          where: {
            projectId: project.id,
            role: Role.PROJECT_MANAGER,
            isActive: true,
          },
        });
        expect(activeManagers).toHaveLength(1);
        expect(activeManagers[0].id).toBe(newManager.id);
      } finally {
        await deleteTestUser(prisma.client, existingManager.id);
        await deleteTestUser(prisma.client, newManager.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects a duplicate email', async () => {
      const email = `dup-${randomUUID()}@example.com`;
      const first = await provisioning.createUser({
        email,
        displayName: 'First',
        password: VALID_PASSWORD,
        role: Role.OWNER,
      });
      try {
        await expect(
          provisioning.createUser({
            email,
            displayName: 'Second',
            password: VALID_PASSWORD,
            role: Role.ACCOUNTANT,
          }),
        ).rejects.toBeInstanceOf(ConflictException);
      } finally {
        await deleteTestUser(prisma.client, first.id);
      }
    });

    it('rejects PROJECT_MANAGER without a projectId', async () => {
      await expect(
        provisioning.createUser({
          email: `no-project-${randomUUID()}@example.com`,
          displayName: 'X',
          password: VALID_PASSWORD,
          role: Role.PROJECT_MANAGER,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a projectId supplied for a non-manager role', async () => {
      const project = await createTestProject(prisma.client);
      try {
        await expect(
          provisioning.createUser({
            email: `extra-project-${randomUUID()}@example.com`,
            displayName: 'X',
            password: VALID_PASSWORD,
            role: Role.OWNER,
            projectId: project.id,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects a nonexistent project for PROJECT_MANAGER', async () => {
      await expect(
        provisioning.createUser({
          email: `ghost-project-${randomUUID()}@example.com`,
          displayName: 'X',
          password: VALID_PASSWORD,
          role: Role.PROJECT_MANAGER,
          projectId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects an invalid email', async () => {
      await expect(
        provisioning.createUser({
          email: 'not-an-email',
          displayName: 'X',
          password: VALID_PASSWORD,
          role: Role.OWNER,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a password shorter than 12 characters', async () => {
      await expect(
        provisioning.createUser({
          email: `short-pw-${randomUUID()}@example.com`,
          displayName: 'X',
          password: 'tooshort',
          role: Role.OWNER,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('never leaves a partially-created user on rejection (no row persisted)', async () => {
      const email = `rejected-${randomUUID()}@example.com`;
      await expect(
        provisioning.createUser({
          email,
          displayName: 'X',
          password: VALID_PASSWORD,
          role: Role.PROJECT_MANAGER, // no projectId -> rejected before any write
        }),
      ).rejects.toThrow();
      const found = await prisma.client.user.findUnique({ where: { email } });
      expect(found).toBeNull();
    });
  });

  describe('database constraints (direct verification, not just service-level)', () => {
    it('CHECK constraint rejects PROJECT_MANAGER without a projectId at the SQL level', async () => {
      await expect(
        prisma.client.$executeRaw`
          INSERT INTO "User" (id, email, "displayName", "passwordHash", role, "isActive", "updatedAt")
          VALUES (gen_random_uuid(), ${`direct-${randomUUID()}@example.com`}, 'X', 'hash', 'PROJECT_MANAGER'::"Role", true, now())
        `,
      ).rejects.toThrow(/User_role_projectId_check/);
    });

    it('CHECK constraint rejects a non-lowercase email at the SQL level', async () => {
      await expect(
        prisma.client.$executeRaw`
          INSERT INTO "User" (id, email, "displayName", "passwordHash", role, "isActive", "updatedAt")
          VALUES (gen_random_uuid(), ${`Direct-${randomUUID()}@Example.com`}, 'X', 'hash', 'OWNER'::"Role", true, now())
        `,
      ).rejects.toThrow(/User_email_lowercase_check/);
    });

    it('partial unique index rejects a second ACTIVE manager for the same project at the SQL level', async () => {
      const project = await createTestProject(prisma.client);
      const managerA = await createTestUser(prisma.client, {
        role: Role.PROJECT_MANAGER,
        projectId: project.id,
      });
      try {
        await expect(
          prisma.client.$executeRaw`
            INSERT INTO "User" (id, email, "displayName", "passwordHash", role, "projectId", "isActive", "updatedAt")
            VALUES (gen_random_uuid(), ${`direct-${randomUUID()}@example.com`}, 'X', 'hash', 'PROJECT_MANAGER'::"Role", ${project.id}::uuid, true, now())
          `,
        ).rejects.toThrow(/User_one_active_manager_per_project/);
      } finally {
        await deleteTestUser(prisma.client, managerA.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('the partial unique index allows an INACTIVE second manager row for the same project', async () => {
      const project = await createTestProject(prisma.client);
      const managerA = await createTestUser(prisma.client, {
        role: Role.PROJECT_MANAGER,
        projectId: project.id,
      });
      const managerB = await createTestUser(prisma.client, {
        role: Role.PROJECT_MANAGER,
        projectId: project.id,
        isActive: false,
      });
      try {
        const rows = await prisma.client.user.findMany({
          where: { projectId: project.id },
        });
        expect(rows).toHaveLength(2);
      } finally {
        await deleteTestUser(prisma.client, managerA.id);
        await deleteTestUser(prisma.client, managerB.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('composite FK rejects a Floor whose projectId does not match its blockId', async () => {
      const projectA = await createTestProject(prisma.client, 'A');
      const projectB = await createTestProject(prisma.client, 'B');
      const block = await prisma.client.buildingBlock.create({
        data: {
          projectId: projectA.id,
          name: 'Block',
          code: `block-${randomUUID()}`,
        },
      });
      try {
        await expect(
          prisma.client.$executeRaw`
            INSERT INTO "Floor" (id, "projectId", "blockId", label, "sortOrder", "updatedAt")
            VALUES (gen_random_uuid(), ${projectB.id}::uuid, ${block.id}::uuid, 'Floor 1', 1, now())
          `,
        ).rejects.toThrow(/Floor_projectId_blockId_fkey/);
      } finally {
        await prisma.client.buildingBlock.delete({ where: { id: block.id } });
        await deleteTestProject(prisma.client, projectA.id);
        await deleteTestProject(prisma.client, projectB.id);
      }
    });
  });
});
