import { randomUUID } from 'node:crypto';
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

describe('Transaction categories (e2e)', () => {
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

  async function setupProjectAndManager() {
    const project = await createTestProject(
      prisma.client,
      `Category Test ${randomUUID()}`,
    );
    const manager = await createTestUser(prisma.client, {
      role: Role.PROJECT_MANAGER,
      projectId: project.id,
    });
    const token = await loginTestUser(app.getHttpServer(), manager.email);
    return { project, manager, token };
  }

  it('creates, lists, renames, and archives a category', async () => {
    const { project, token } = await setupProjectAndManager();
    try {
      const created = await request(app.getHttpServer())
        .post(`/projects/${project.id}/transaction-categories`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Materials', kind: 'EXPENSE' })
        .expect(201);
      expect(created.body.isActive).toBe(true);

      const list = await request(app.getHttpServer())
        .get(`/projects/${project.id}/transaction-categories`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(list.body).toHaveLength(1);

      const renamed = await request(app.getHttpServer())
        .patch(
          `/projects/${project.id}/transaction-categories/${created.body.id}`,
        )
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Materials & Supplies' })
        .expect(200);
      expect(renamed.body.name).toBe('Materials & Supplies');

      const archived = await request(app.getHttpServer())
        .patch(
          `/projects/${project.id}/transaction-categories/${created.body.id}`,
        )
        .set('Authorization', `Bearer ${token}`)
        .send({ isActive: false })
        .expect(200);
      expect(archived.body.isActive).toBe(false);
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });

  it('rejects a duplicate (projectId, kind, name)', async () => {
    const { project, token } = await setupProjectAndManager();
    try {
      await request(app.getHttpServer())
        .post(`/projects/${project.id}/transaction-categories`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Rent', kind: 'EXPENSE' })
        .expect(201);

      const response = await request(app.getHttpServer())
        .post(`/projects/${project.id}/transaction-categories`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Rent', kind: 'EXPENSE' })
        .expect(409);
      expect(response.body.code).toBe('UNIQUE_CONSTRAINT_VIOLATION');
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });

  it('allows the same name under different kinds', async () => {
    const { project, token } = await setupProjectAndManager();
    try {
      await request(app.getHttpServer())
        .post(`/projects/${project.id}/transaction-categories`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Other', kind: 'EXPENSE' })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/projects/${project.id}/transaction-categories`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Other', kind: 'INCOME' })
        .expect(201);
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });

  it('OWNER cannot create a category', async () => {
    const project = await createTestProject(
      prisma.client,
      `Owner Category Test ${randomUUID()}`,
    );
    const owner = await createTestUser(prisma.client, { role: Role.OWNER });
    try {
      const token = await loginTestUser(app.getHttpServer(), owner.email);
      await request(app.getHttpServer())
        .post(`/projects/${project.id}/transaction-categories`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Materials', kind: 'EXPENSE' })
        .expect(403);
    } finally {
      await deleteTestUser(prisma.client, owner.id);
      await deleteTestProject(prisma.client, project.id);
    }
  });

  it('returns 404 for a category belonging to a different project', async () => {
    const { project, token } = await setupProjectAndManager();
    const other = await setupProjectAndManager();
    try {
      const category = await request(app.getHttpServer())
        .post(`/projects/${other.project.id}/transaction-categories`)
        .set('Authorization', `Bearer ${other.token}`)
        .send({ name: 'Materials', kind: 'EXPENSE' })
        .expect(201);

      await request(app.getHttpServer())
        .patch(
          `/projects/${project.id}/transaction-categories/${category.body.id}`,
        )
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Hijack attempt' })
        .expect(404);
    } finally {
      await deleteTestProject(prisma.client, project.id);
      await deleteTestProject(prisma.client, other.project.id);
    }
  });
});
