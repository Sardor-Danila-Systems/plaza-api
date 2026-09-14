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

describe('Currency rates (e2e)', () => {
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
      `Rate Test ${randomUUID()}`,
    );
    const manager = await createTestUser(prisma.client, {
      role: Role.PROJECT_MANAGER,
      projectId: project.id,
    });
    const token = await loginTestUser(app.getHttpServer(), manager.email);
    return { project, manager, token };
  }

  it('records a manual USD quote and lists it', async () => {
    const { project, token } = await setupProjectAndManager();
    try {
      const created = await request(app.getHttpServer())
        .post(`/projects/${project.id}/currency-rates`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          currency: 'USD',
          rateUzs: '12500.00000000',
          effectiveOn: '2026-09-14',
        })
        .expect(201);
      expect(created.body.source).toBe('MANUAL');
      expect(created.body.rateUzs).toBe('12500.00000000');

      const list = await request(app.getHttpServer())
        .get(`/projects/${project.id}/currency-rates`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].id).toBe(created.body.id);
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });

  it('is append-only: two rates for the same day both persist', async () => {
    const { project, token } = await setupProjectAndManager();
    try {
      await request(app.getHttpServer())
        .post(`/projects/${project.id}/currency-rates`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          currency: 'USD',
          rateUzs: '12500.00000000',
          effectiveOn: '2026-09-14',
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/projects/${project.id}/currency-rates`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          currency: 'USD',
          rateUzs: '12550.00000000',
          effectiveOn: '2026-09-14',
        })
        .expect(201);

      const list = await request(app.getHttpServer())
        .get(`/projects/${project.id}/currency-rates`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(list.body).toHaveLength(2);
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });

  it('rejects UZS as the quoted currency', async () => {
    const { project, token } = await setupProjectAndManager();
    try {
      await request(app.getHttpServer())
        .post(`/projects/${project.id}/currency-rates`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          currency: 'UZS',
          rateUzs: '1.00000000',
          effectiveOn: '2026-09-14',
        })
        .expect(400);
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });

  it('rejects a non-positive rate', async () => {
    const { project, token } = await setupProjectAndManager();
    try {
      await request(app.getHttpServer())
        .post(`/projects/${project.id}/currency-rates`)
        .set('Authorization', `Bearer ${token}`)
        .send({ currency: 'USD', rateUzs: '0', effectiveOn: '2026-09-14' })
        .expect(400);
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });

  it('OWNER can list but not create currency rates', async () => {
    const project = await createTestProject(
      prisma.client,
      `Owner Rate Test ${randomUUID()}`,
    );
    const owner = await createTestUser(prisma.client, { role: Role.OWNER });
    try {
      const token = await loginTestUser(app.getHttpServer(), owner.email);
      await request(app.getHttpServer())
        .get(`/projects/${project.id}/currency-rates`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/projects/${project.id}/currency-rates`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          currency: 'USD',
          rateUzs: '12500.00000000',
          effectiveOn: '2026-09-14',
        })
        .expect(403);
    } finally {
      await deleteTestUser(prisma.client, owner.id);
      await deleteTestProject(prisma.client, project.id);
    }
  });
});
