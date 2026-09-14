import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Role } from '../src/generated/prisma/client.js';
import { setupApp } from '../src/setup-app.js';
import {
  createTestBlock,
  createTestFloor,
  createTestProject,
  createTestUser,
  deleteTestProject,
  deleteTestUser,
  loginTestUser,
} from './fixtures/auth.fixture.js';

describe('Construction floors (e2e)', () => {
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

  async function setupProjectBlockManager() {
    const project = await createTestProject(prisma.client);
    const block = await createTestBlock(prisma.client, project.id);
    const manager = await createTestUser(prisma.client, {
      role: Role.PROJECT_MANAGER,
      projectId: project.id,
    });
    const token = await loginTestUser(app.getHttpServer(), manager.email);
    return { project, block, manager, token };
  }

  describe('POST .../floors', () => {
    it('PROJECT_MANAGER creates a floor', async () => {
      const { project, block, manager, token } =
        await setupProjectBlockManager();
      try {
        const response = await request(app.getHttpServer())
          .post(
            `/projects/${project.id}/construction/blocks/${block.id}/floors`,
          )
          .set('Authorization', `Bearer ${token}`)
          .send({ label: 'Floor 3', sortOrder: 3 })
          .expect(201);
        expect(response.body).toMatchObject({
          projectId: project.id,
          blockId: block.id,
          label: 'Floor 3',
          sortOrder: 3,
        });
      } finally {
        await deleteTestUser(prisma.client, manager.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects a duplicate floor label in the same block', async () => {
      const { project, block, manager, token } =
        await setupProjectBlockManager();
      try {
        await request(app.getHttpServer())
          .post(
            `/projects/${project.id}/construction/blocks/${block.id}/floors`,
          )
          .set('Authorization', `Bearer ${token}`)
          .send({ label: 'Floor 3', sortOrder: 3 })
          .expect(201);

        const response = await request(app.getHttpServer())
          .post(
            `/projects/${project.id}/construction/blocks/${block.id}/floors`,
          )
          .set('Authorization', `Bearer ${token}`)
          .send({ label: 'Floor 3', sortOrder: 4 })
          .expect(409);
        expect(response.body.code).toBe('UNIQUE_CONSTRAINT_VIOLATION');
      } finally {
        await deleteTestUser(prisma.client, manager.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('allows the same floor label in a different block of the same project', async () => {
      const {
        project,
        block: blockA,
        manager,
        token,
      } = await setupProjectBlockManager();
      const blockB = await createTestBlock(prisma.client, project.id);
      try {
        await request(app.getHttpServer())
          .post(
            `/projects/${project.id}/construction/blocks/${blockA.id}/floors`,
          )
          .set('Authorization', `Bearer ${token}`)
          .send({ label: 'Floor 3', sortOrder: 3 })
          .expect(201);
        await request(app.getHttpServer())
          .post(
            `/projects/${project.id}/construction/blocks/${blockB.id}/floors`,
          )
          .set('Authorization', `Bearer ${token}`)
          .send({ label: 'Floor 3', sortOrder: 3 })
          .expect(201);
      } finally {
        await deleteTestUser(prisma.client, manager.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects creating a floor under a block from a foreign project', async () => {
      const {
        project: ownProject,
        manager,
        token,
      } = await setupProjectBlockManager();
      const foreignProject = await createTestProject(prisma.client, 'Foreign');
      const foreignBlock = await createTestBlock(
        prisma.client,
        foreignProject.id,
      );
      try {
        const response = await request(app.getHttpServer())
          .post(
            `/projects/${ownProject.id}/construction/blocks/${foreignBlock.id}/floors`,
          )
          .set('Authorization', `Bearer ${token}`)
          .send({ label: 'Floor 1', sortOrder: 1 })
          .expect(404);
        expect(response.body.code).toBe('BLOCK_PROJECT_MISMATCH');
      } finally {
        await deleteTestUser(prisma.client, manager.id);
        await deleteTestProject(prisma.client, ownProject.id);
        await deleteTestProject(prisma.client, foreignProject.id);
      }
    });

    it('OWNER/ACCOUNTANT cannot create floors', async () => {
      const { project, block } = await setupProjectBlockManager();
      const owner = await createTestUser(prisma.client, { role: Role.OWNER });
      try {
        const token = await loginTestUser(app.getHttpServer(), owner.email);
        await request(app.getHttpServer())
          .post(
            `/projects/${project.id}/construction/blocks/${block.id}/floors`,
          )
          .set('Authorization', `Bearer ${token}`)
          .send({ label: 'Floor 1', sortOrder: 1 })
          .expect(403);
      } finally {
        await deleteTestUser(prisma.client, owner.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });

  describe('GET .../floors', () => {
    it('lists floors ordered by sortOrder', async () => {
      const { project, block, manager, token } =
        await setupProjectBlockManager();
      await createTestFloor(prisma.client, project.id, block.id, {
        label: 'B',
        sortOrder: 2,
      });
      await createTestFloor(prisma.client, project.id, block.id, {
        label: 'A',
        sortOrder: 1,
      });
      try {
        const response = await request(app.getHttpServer())
          .get(`/projects/${project.id}/construction/blocks/${block.id}/floors`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(response.body.map((f: { label: string }) => f.label)).toEqual([
          'A',
          'B',
        ]);
      } finally {
        await deleteTestUser(prisma.client, manager.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });

  describe('nested resource mismatch protection', () => {
    it('a floor that exists in the project but under a DIFFERENT block returns FLOOR_BLOCK_MISMATCH', async () => {
      const {
        project,
        block: blockA,
        manager,
        token,
      } = await setupProjectBlockManager();
      const blockB = await createTestBlock(prisma.client, project.id);
      const floorInB = await createTestFloor(
        prisma.client,
        project.id,
        blockB.id,
      );

      try {
        const response = await request(app.getHttpServer())
          .get(
            `/projects/${project.id}/construction/blocks/${blockA.id}/floors/${floorInB.id}`,
          )
          .set('Authorization', `Bearer ${token}`)
          .expect(404);
        expect(response.body.code).toBe('FLOOR_BLOCK_MISMATCH');
      } finally {
        await deleteTestUser(prisma.client, manager.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('a floor from an entirely different project returns FLOOR_PROJECT_MISMATCH', async () => {
      const {
        project: ownProject,
        block: ownBlock,
        manager,
        token,
      } = await setupProjectBlockManager();
      const foreignProject = await createTestProject(prisma.client, 'Foreign');
      const foreignBlock = await createTestBlock(
        prisma.client,
        foreignProject.id,
      );
      const foreignFloor = await createTestFloor(
        prisma.client,
        foreignProject.id,
        foreignBlock.id,
      );

      try {
        const response = await request(app.getHttpServer())
          .get(
            `/projects/${ownProject.id}/construction/blocks/${ownBlock.id}/floors/${foreignFloor.id}`,
          )
          .set('Authorization', `Bearer ${token}`)
          .expect(404);
        expect(response.body.code).toBe('FLOOR_PROJECT_MISMATCH');
      } finally {
        await deleteTestUser(prisma.client, manager.id);
        await deleteTestProject(prisma.client, ownProject.id);
        await deleteTestProject(prisma.client, foreignProject.id);
      }
    });
  });

  describe('PATCH (archive/restore)', () => {
    it('archives a floor without deleting it', async () => {
      const { project, block, manager, token } =
        await setupProjectBlockManager();
      const floor = await createTestFloor(prisma.client, project.id, block.id);
      try {
        const response = await request(app.getHttpServer())
          .patch(
            `/projects/${project.id}/construction/blocks/${block.id}/floors/${floor.id}`,
          )
          .set('Authorization', `Bearer ${token}`)
          .send({ isActive: false })
          .expect(200);
        expect(response.body.isActive).toBe(false);

        const stillThere = await prisma.client.floor.findUnique({
          where: { id: floor.id },
        });
        expect(stillThere).not.toBeNull();
      } finally {
        await deleteTestUser(prisma.client, manager.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });
});
