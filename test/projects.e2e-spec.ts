import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Role } from '../src/generated/prisma/client.js';
import { setupApp } from '../src/setup-app.js';
import {
  createTestProject,
  createTestUser,
  deleteTestProject,
  deleteTestUser,
  loginTestUser,
} from './fixtures/auth.fixture.js';

describe('Projects (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /projects', () => {
    it('OWNER sees all active projects, not inactive ones', async () => {
      const owner = await createTestUser(prisma.client, { role: Role.OWNER });
      const projectA = await createTestProject(prisma.client, 'Alpha');
      const projectB = await createTestProject(prisma.client, 'Beta');
      const inactiveProject = await prisma.client.project.create({
        data: {
          name: 'Gamma (inactive)',
          code: `inactive-${Date.now()}`,
          isActive: false,
        },
      });

      try {
        const token = await loginTestUser(app.getHttpServer(), owner.email);
        const response = await request(app.getHttpServer())
          .get('/projects')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);

        const ids = response.body.map((p: { id: string }) => p.id);
        expect(ids).toEqual(expect.arrayContaining([projectA.id, projectB.id]));
        expect(ids).not.toContain(inactiveProject.id);
      } finally {
        await deleteTestUser(prisma.client, owner.id);
        await deleteTestProject(prisma.client, projectA.id);
        await deleteTestProject(prisma.client, projectB.id);
        await deleteTestProject(prisma.client, inactiveProject.id);
      }
    });

    it('ACCOUNTANT sees all active projects too', async () => {
      const accountant = await createTestUser(prisma.client, {
        role: Role.ACCOUNTANT,
      });
      const project = await createTestProject(prisma.client);

      try {
        const token = await loginTestUser(
          app.getHttpServer(),
          accountant.email,
        );
        const response = await request(app.getHttpServer())
          .get('/projects')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(response.body.map((p: { id: string }) => p.id)).toContain(
          project.id,
        );
      } finally {
        await deleteTestUser(prisma.client, accountant.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('PROJECT_MANAGER sees only their own assigned project (database-filtered)', async () => {
      const ownProject = await createTestProject(prisma.client, 'Own');
      const otherProject = await createTestProject(prisma.client, 'Other');
      const manager = await createTestUser(prisma.client, {
        role: Role.PROJECT_MANAGER,
        projectId: ownProject.id,
      });

      try {
        const token = await loginTestUser(app.getHttpServer(), manager.email);
        const response = await request(app.getHttpServer())
          .get('/projects')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);

        expect(response.body).toHaveLength(1);
        expect(response.body[0].id).toBe(ownProject.id);
      } finally {
        await deleteTestUser(prisma.client, manager.id);
        await deleteTestProject(prisma.client, ownProject.id);
        await deleteTestProject(prisma.client, otherProject.id);
      }
    });

    it('includes safe manager summary fields only', async () => {
      const project = await createTestProject(prisma.client);
      const manager = await createTestUser(prisma.client, {
        role: Role.PROJECT_MANAGER,
        projectId: project.id,
      });
      const owner = await createTestUser(prisma.client, { role: Role.OWNER });

      try {
        const token = await loginTestUser(app.getHttpServer(), owner.email);
        const response = await request(app.getHttpServer())
          .get(`/projects/${project.id}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);

        expect(response.body.manager).toEqual({
          id: manager.id,
          displayName: manager.displayName,
          email: manager.email,
        });
        expect(JSON.stringify(response.body)).not.toMatch(/passwordHash/i);
      } finally {
        await deleteTestUser(prisma.client, owner.id);
        await deleteTestUser(prisma.client, manager.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });

  describe('GET /projects/:projectId', () => {
    it('PROJECT_MANAGER can read their own project', async () => {
      const project = await createTestProject(prisma.client);
      const manager = await createTestUser(prisma.client, {
        role: Role.PROJECT_MANAGER,
        projectId: project.id,
      });

      try {
        const token = await loginTestUser(app.getHttpServer(), manager.email);
        await request(app.getHttpServer())
          .get(`/projects/${project.id}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
      } finally {
        await deleteTestUser(prisma.client, manager.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('PROJECT_MANAGER cannot read a foreign project (403, not 404 — no existence leak)', async () => {
      const ownProject = await createTestProject(prisma.client, 'Own');
      const foreignProject = await createTestProject(prisma.client, 'Foreign');
      const manager = await createTestUser(prisma.client, {
        role: Role.PROJECT_MANAGER,
        projectId: ownProject.id,
      });

      try {
        const token = await loginTestUser(app.getHttpServer(), manager.email);
        const response = await request(app.getHttpServer())
          .get(`/projects/${foreignProject.id}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(403);
        expect(response.body.code).toBe('PROJECT_ACCESS_DENIED');
      } finally {
        await deleteTestUser(prisma.client, manager.id);
        await deleteTestProject(prisma.client, ownProject.id);
        await deleteTestProject(prisma.client, foreignProject.id);
      }
    });

    it('returns 404 for a nonexistent project ID (OWNER, who is allowed to read any project)', async () => {
      const owner = await createTestUser(prisma.client, { role: Role.OWNER });
      try {
        const token = await loginTestUser(app.getHttpServer(), owner.email);
        const response = await request(app.getHttpServer())
          .get('/projects/00000000-0000-0000-0000-000000000000')
          .set('Authorization', `Bearer ${token}`)
          .expect(404);
        expect(response.body.code).toBe('NOT_FOUND');
      } finally {
        await deleteTestUser(prisma.client, owner.id);
      }
    });

    it('an inactive project is invisible even to its own assigned manager (Phase 3 §8: conservative, documented, no exception)', async () => {
      const project = await createTestProject(prisma.client);
      const manager = await createTestUser(prisma.client, {
        role: Role.PROJECT_MANAGER,
        projectId: project.id,
      });

      try {
        const token = await loginTestUser(app.getHttpServer(), manager.email);
        await prisma.client.project.update({
          where: { id: project.id },
          data: { isActive: false },
        });

        const single = await request(app.getHttpServer())
          .get(`/projects/${project.id}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(404);
        expect(single.body.code).toBe('NOT_FOUND');

        const list = await request(app.getHttpServer())
          .get('/projects')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(list.body).toEqual([]);
      } finally {
        await deleteTestUser(prisma.client, manager.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });

  describe('PATCH /projects/:projectId (Phase 3.1: removed entirely)', () => {
    it('does not exist for PROJECT_MANAGER, even on their own project', async () => {
      const project = await createTestProject(prisma.client);
      const manager = await createTestUser(prisma.client, {
        role: Role.PROJECT_MANAGER,
        projectId: project.id,
      });

      try {
        const token = await loginTestUser(app.getHttpServer(), manager.email);
        await request(app.getHttpServer())
          .patch(`/projects/${project.id}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Attempted rename' })
          .expect(404);

        // Proves this is "no route", not "denied write": the name is
        // provably unchanged.
        const unchanged = await prisma.client.project.findUniqueOrThrow({
          where: { id: project.id },
        });
        expect(unchanged.name).toBe(project.name);
      } finally {
        await deleteTestUser(prisma.client, manager.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('does not exist for OWNER either (no write path was added as a substitute)', async () => {
      const project = await createTestProject(prisma.client);
      const owner = await createTestUser(prisma.client, { role: Role.OWNER });

      try {
        const token = await loginTestUser(app.getHttpServer(), owner.email);
        await request(app.getHttpServer())
          .patch(`/projects/${project.id}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Hacked' })
          .expect(404);
      } finally {
        await deleteTestUser(prisma.client, owner.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('does not exist for ACCOUNTANT either', async () => {
      const project = await createTestProject(prisma.client);
      const accountant = await createTestUser(prisma.client, {
        role: Role.ACCOUNTANT,
      });

      try {
        const token = await loginTestUser(
          app.getHttpServer(),
          accountant.email,
        );
        await request(app.getHttpServer())
          .patch(`/projects/${project.id}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Hacked' })
          .expect(404);
      } finally {
        await deleteTestUser(prisma.client, accountant.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });

  describe('no project-creation endpoint exists', () => {
    it('POST /projects does not exist for any role (404), preserving OWNER read-only semantics', async () => {
      const owner = await createTestUser(prisma.client, { role: Role.OWNER });
      try {
        const token = await loginTestUser(app.getHttpServer(), owner.email);
        await request(app.getHttpServer())
          .post('/projects')
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'New Project', code: 'new-project' })
          .expect(404);
      } finally {
        await deleteTestUser(prisma.client, owner.id);
      }
    });
  });
});
