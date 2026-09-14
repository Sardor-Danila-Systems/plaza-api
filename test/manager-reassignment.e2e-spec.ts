import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Role } from '../src/generated/prisma/client.js';
import { ProjectProvisioningService } from '../src/modules/projects/project-provisioning.service.js';
import { setupApp } from '../src/setup-app.js';
import {
  createTestProject,
  createTestUser,
  deleteTestProject,
  deleteTestUser,
  loginTestUser,
} from './fixtures/auth.fixture.js';

/**
 * The exact scenario from Phase 3 §10/§35, against real PostgreSQL and real
 * HTTP requests: an already-issued access token must stop granting project
 * access the moment its holder is reassigned away, with zero new mechanism
 * beyond what Phase 2 already built (docs/adr/0009,
 * docs/adr/0013-project-manager-relation.md).
 */
describe('Manager reassignment (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let provisioning: ProjectProvisioningService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    provisioning = app.get(ProjectProvisioningService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('reassigning a project immediately revokes the old manager access token and grants the new one', async () => {
    const project = await createTestProject(prisma.client, 'Avenue Plaza Test');
    const managerA = await createTestUser(prisma.client, {
      role: Role.PROJECT_MANAGER,
      projectId: project.id,
    });
    const managerB = await createTestUser(prisma.client, {
      role: Role.ACCOUNTANT,
    });

    try {
      // 1-3: Manager A logs in and can access their project.
      const tokenA = await loginTestUser(app.getHttpServer(), managerA.email);
      await request(app.getHttpServer())
        .get(`/projects/${project.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      // 4: Operator reassigns the project to Manager B.
      await provisioning.assignManager(project.id, managerB.id);

      // 5: Manager A's SAME already-issued access token immediately fails —
      // no new login, no waiting for expiry, no separate revocation call.
      const stillTokenA = await request(app.getHttpServer())
        .get(`/projects/${project.id}`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(stillTokenA.status).toBe(403);
      expect(stillTokenA.body.code).toBe('USER_DISABLED');

      // 6: Manager B gains access according to the current DB assignment.
      const tokenB = await loginTestUser(app.getHttpServer(), managerB.email);
      const asB = await request(app.getHttpServer())
        .get(`/projects/${project.id}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);
      expect(asB.body.manager).toMatchObject({ id: managerB.id });

      // 7: Historical actor identity is untouched — Manager A's own user
      // record still shows their (frozen) role/projectId history.
      const historicalA = await prisma.client.user.findUniqueOrThrow({
        where: { id: managerA.id },
      });
      expect(historicalA.role).toBe(Role.PROJECT_MANAGER);
      expect(historicalA.projectId).toBe(project.id);
      expect(historicalA.isActive).toBe(false);
    } finally {
      await deleteTestUser(prisma.client, managerA.id);
      await deleteTestUser(prisma.client, managerB.id);
      await deleteTestProject(prisma.client, project.id);
    }
  });

  it('the old manager cannot refresh their session after reassignment either', async () => {
    const project = await createTestProject(prisma.client, 'Palma Plaza Test');
    const managerA = await createTestUser(prisma.client, {
      role: Role.PROJECT_MANAGER,
      projectId: project.id,
    });
    const managerB = await createTestUser(prisma.client, {
      role: Role.ACCOUNTANT,
    });

    try {
      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: managerA.email,
          password: 'a-perfectly-fine-test-password-1',
        })
        .expect(200);
      const setCookies = loginResponse.headers[
        'set-cookie'
      ] as unknown as string[];
      const cookieHeader = setCookies.map((c) => c.split(';')[0]).join('; ');
      const csrfCookie = setCookies.find((c) => c.startsWith('csrf_token='));
      const csrf = csrfCookie!.split(';')[0].split('=')[1];

      await provisioning.assignManager(project.id, managerB.id);

      const refreshAttempt = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', cookieHeader)
        .set('X-CSRF-Token', csrf);
      expect(refreshAttempt.status).toBe(403);
      expect(refreshAttempt.body.code).toBe('USER_DISABLED');
    } finally {
      await deleteTestUser(prisma.client, managerA.id);
      await deleteTestUser(prisma.client, managerB.id);
      await deleteTestProject(prisma.client, project.id);
    }
  });
});
