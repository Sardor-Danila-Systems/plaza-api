import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Role } from '../src/generated/prisma/client.js';
import { setupApp } from '../src/setup-app.js';
import {
  createTestBlock,
  createTestProject,
  createTestUser,
  deleteTestProject,
  deleteTestUser,
  loginTestUser,
} from './fixtures/auth.fixture.js';

describe('Construction blocks (e2e)', () => {
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

  async function setupProjectWithManager() {
    const project = await createTestProject(prisma.client);
    const manager = await createTestUser(prisma.client, {
      role: Role.PROJECT_MANAGER,
      projectId: project.id,
    });
    const token = await loginTestUser(app.getHttpServer(), manager.email);
    return { project, manager, token };
  }

  describe('POST /projects/:projectId/construction/blocks', () => {
    it('PROJECT_MANAGER creates a block in their own project', async () => {
      const { project, manager, token } = await setupProjectWithManager();
      try {
        const response = await request(app.getHttpServer())
          .post(`/projects/${project.id}/construction/blocks`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Block A', code: 'block-a' })
          .expect(201);
        expect(response.body).toMatchObject({
          projectId: project.id,
          name: 'Block A',
          code: 'block-a',
          isActive: true,
        });
      } finally {
        await deleteTestUser(prisma.client, manager.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('OWNER cannot create a block', async () => {
      const project = await createTestProject(prisma.client);
      const owner = await createTestUser(prisma.client, { role: Role.OWNER });
      try {
        const token = await loginTestUser(app.getHttpServer(), owner.email);
        const response = await request(app.getHttpServer())
          .post(`/projects/${project.id}/construction/blocks`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Block A', code: 'block-a' })
          .expect(403);
        expect(response.body.code).toBe('PROJECT_ACCESS_DENIED');
      } finally {
        await deleteTestUser(prisma.client, owner.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('ACCOUNTANT cannot create a block', async () => {
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
          .post(`/projects/${project.id}/construction/blocks`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Block A', code: 'block-a' })
          .expect(403);
      } finally {
        await deleteTestUser(prisma.client, accountant.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('PROJECT_MANAGER cannot create a block in a foreign project', async () => {
      const {
        project: ownProject,
        manager,
        token,
      } = await setupProjectWithManager();
      const foreignProject = await createTestProject(prisma.client, 'Foreign');
      try {
        const response = await request(app.getHttpServer())
          .post(`/projects/${foreignProject.id}/construction/blocks`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Block A', code: 'block-a' })
          .expect(403);
        expect(response.body.code).toBe('PROJECT_ACCESS_DENIED');
      } finally {
        await deleteTestUser(prisma.client, manager.id);
        await deleteTestProject(prisma.client, ownProject.id);
        await deleteTestProject(prisma.client, foreignProject.id);
      }
    });

    it('rejects a duplicate block code within the same project', async () => {
      const { project, manager, token } = await setupProjectWithManager();
      try {
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/construction/blocks`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Block A', code: 'block-a' })
          .expect(201);

        const response = await request(app.getHttpServer())
          .post(`/projects/${project.id}/construction/blocks`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Block A Again', code: 'block-a' })
          .expect(409);
        expect(response.body.code).toBe('UNIQUE_CONSTRAINT_VIOLATION');
      } finally {
        await deleteTestUser(prisma.client, manager.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('allows the same block code in a different project', async () => {
      const {
        project: projectA,
        manager: managerA,
        token: tokenA,
      } = await setupProjectWithManager();
      const {
        project: projectB,
        manager: managerB,
        token: tokenB,
      } = await setupProjectWithManager();
      try {
        await request(app.getHttpServer())
          .post(`/projects/${projectA.id}/construction/blocks`)
          .set('Authorization', `Bearer ${tokenA}`)
          .send({ name: 'Block A', code: 'shared-code' })
          .expect(201);
        await request(app.getHttpServer())
          .post(`/projects/${projectB.id}/construction/blocks`)
          .set('Authorization', `Bearer ${tokenB}`)
          .send({ name: 'Block A', code: 'shared-code' })
          .expect(201);
      } finally {
        await deleteTestUser(prisma.client, managerA.id);
        await deleteTestUser(prisma.client, managerB.id);
        await deleteTestProject(prisma.client, projectA.id);
        await deleteTestProject(prisma.client, projectB.id);
      }
    });

    it('rejects an invalid code format', async () => {
      const { project, manager, token } = await setupProjectWithManager();
      try {
        const response = await request(app.getHttpServer())
          .post(`/projects/${project.id}/construction/blocks`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Block A', code: 'Block A!' })
          .expect(400);
        expect(response.body.code).toBe('VALIDATION_ERROR');
      } finally {
        await deleteTestUser(prisma.client, manager.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });

  describe('GET /projects/:projectId/construction/blocks', () => {
    it('lists blocks in a project', async () => {
      const { project, manager, token } = await setupProjectWithManager();
      const block = await createTestBlock(prisma.client, project.id);
      try {
        const response = await request(app.getHttpServer())
          .get(`/projects/${project.id}/construction/blocks`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(response.body.map((b: { id: string }) => b.id)).toContain(
          block.id,
        );
      } finally {
        await deleteTestUser(prisma.client, manager.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('OWNER/ACCOUNTANT can read blocks (read-only everywhere, not just projects)', async () => {
      const project = await createTestProject(prisma.client);
      const block = await createTestBlock(prisma.client, project.id);
      const owner = await createTestUser(prisma.client, { role: Role.OWNER });
      try {
        const token = await loginTestUser(app.getHttpServer(), owner.email);
        const response = await request(app.getHttpServer())
          .get(`/projects/${project.id}/construction/blocks/${block.id}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(response.body.id).toBe(block.id);
      } finally {
        await deleteTestUser(prisma.client, owner.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });

  describe('nested resource project-mismatch protection', () => {
    it('a real block ID from a DIFFERENT project returns BLOCK_PROJECT_MISMATCH (404), not the block', async () => {
      const {
        project: ownProject,
        manager,
        token,
      } = await setupProjectWithManager();
      const foreignProject = await createTestProject(prisma.client, 'Foreign');
      const foreignBlock = await createTestBlock(
        prisma.client,
        foreignProject.id,
      );

      try {
        const response = await request(app.getHttpServer())
          .get(
            `/projects/${ownProject.id}/construction/blocks/${foreignBlock.id}`,
          )
          .set('Authorization', `Bearer ${token}`)
          .expect(404);
        expect(response.body.code).toBe('BLOCK_PROJECT_MISMATCH');
      } finally {
        await deleteTestUser(prisma.client, manager.id);
        await deleteTestProject(prisma.client, ownProject.id);
        await deleteTestProject(prisma.client, foreignProject.id);
      }
    });

    it('cannot update a block using a mismatched project in the URL', async () => {
      const {
        project: ownProject,
        manager,
        token,
      } = await setupProjectWithManager();
      const foreignProject = await createTestProject(prisma.client, 'Foreign');
      const foreignBlock = await createTestBlock(
        prisma.client,
        foreignProject.id,
      );

      try {
        const response = await request(app.getHttpServer())
          .patch(
            `/projects/${ownProject.id}/construction/blocks/${foreignBlock.id}`,
          )
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Hacked' })
          .expect(404);
        expect(response.body.code).toBe('BLOCK_PROJECT_MISMATCH');
      } finally {
        await deleteTestUser(prisma.client, manager.id);
        await deleteTestProject(prisma.client, ownProject.id);
        await deleteTestProject(prisma.client, foreignProject.id);
      }
    });
  });

  describe('PATCH (archive/restore, no hard delete)', () => {
    it('archives and restores a block via isActive, and renames it', async () => {
      const { project, manager, token } = await setupProjectWithManager();
      const block = await createTestBlock(prisma.client, project.id);
      try {
        const archived = await request(app.getHttpServer())
          .patch(`/projects/${project.id}/construction/blocks/${block.id}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ isActive: false })
          .expect(200);
        expect(archived.body.isActive).toBe(false);

        const renamed = await request(app.getHttpServer())
          .patch(`/projects/${project.id}/construction/blocks/${block.id}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Renamed', isActive: true })
          .expect(200);
        expect(renamed.body).toMatchObject({ name: 'Renamed', isActive: true });

        // Still exists in the database — no hard delete endpoint exists.
        const stillThere = await prisma.client.buildingBlock.findUnique({
          where: { id: block.id },
        });
        expect(stillThere).not.toBeNull();
      } finally {
        await deleteTestUser(prisma.client, manager.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('does not allow changing the immutable code via PATCH', async () => {
      const { project, manager, token } = await setupProjectWithManager();
      const block = await createTestBlock(prisma.client, project.id);
      try {
        const response = await request(app.getHttpServer())
          .patch(`/projects/${project.id}/construction/blocks/${block.id}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ code: 'new-code' })
          .expect(400);
        expect(response.body.code).toBe('VALIDATION_ERROR');
      } finally {
        await deleteTestUser(prisma.client, manager.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });
});
