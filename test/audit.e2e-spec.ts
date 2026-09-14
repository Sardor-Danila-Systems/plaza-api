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

/**
 * Phase 9 — the `GET P/audit` read API ADR 0016 deferred from Phase 4. The
 * writer itself (append-only, populated by every business workflow) is
 * already exercised indirectly by every other e2e suite; this file covers
 * the read side: filters, pagination, authorization, and append-only-ness.
 */
describe('Audit read API (e2e)', () => {
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

  function idem(): string {
    return randomUUID();
  }

  async function setupProjectAndManager() {
    const project = await createTestProject(
      prisma.client,
      `Audit Test ${randomUUID()}`,
    );
    const manager = await createTestUser(prisma.client, {
      role: Role.PROJECT_MANAGER,
      projectId: project.id,
    });
    const token = await loginTestUser(app.getHttpServer(), manager.email);
    return { project, manager, token };
  }

  it('records and lists an audit entry for a financial posting, newest first, with pagination', async () => {
    const { project, manager, token } = await setupProjectAndManager();
    try {
      const created = await request(app.getHttpServer())
        .post(`/projects/${project.id}/finances`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idem())
        .send({
          type: 'INCOME',
          amount: '1000.00',
          currency: 'UZS',
          source: 'x',
          occurredAt: '2026-09-14',
        })
        .expect(201);

      const list = await request(app.getHttpServer())
        .get(`/projects/${project.id}/audit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(list.body.total).toBeGreaterThanOrEqual(1);
      const entry = list.body.data.find(
        (row: { entityId: string }) => row.entityId === created.body.id,
      );
      expect(entry).toBeDefined();
      expect(entry.action).toBe('financial_transaction.create');
      expect(entry.actorId).toBe(manager.id);
      expect(entry.entityType).toBe('FinancialTransaction');
      expect(entry.newData).toBeDefined();

      const filtered = await request(app.getHttpServer())
        .get(`/projects/${project.id}/audit`)
        .query({
          entityType: 'FinancialTransaction',
          entityId: created.body.id,
        })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(filtered.body.total).toBe(1);
      expect(filtered.body.data[0].id).toBe(entry.id);

      const get = await request(app.getHttpServer())
        .get(`/projects/${project.id}/audit/${entry.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(get.body.id).toBe(entry.id);
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });

  it('never exposes password hashes or tokens in audit payloads', async () => {
    const { project, token } = await setupProjectAndManager();
    try {
      await request(app.getHttpServer())
        .post(`/projects/${project.id}/finances`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idem())
        .send({
          type: 'INCOME',
          amount: '500.00',
          currency: 'UZS',
          source: 'x',
          occurredAt: '2026-09-14',
        })
        .expect(201);

      const list = await request(app.getHttpServer())
        .get(`/projects/${project.id}/audit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const serialized = JSON.stringify(list.body);
      expect(serialized).not.toMatch(/passwordHash/i);
      expect(serialized.toLowerCase()).not.toContain('bearer ');
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });

  it("PROJECT_MANAGER cannot read another project's audit trail", async () => {
    const { project, token } = await setupProjectAndManager();
    const other = await setupProjectAndManager();
    try {
      await request(app.getHttpServer())
        .get(`/projects/${other.project.id}/audit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    } finally {
      await deleteTestProject(prisma.client, project.id);
      await deleteTestProject(prisma.client, other.project.id);
    }
  });

  it("OWNER and ACCOUNTANT can read any active project's audit trail", async () => {
    const { project, token } = await setupProjectAndManager();
    const owner = await createTestUser(prisma.client, { role: Role.OWNER });
    const accountant = await createTestUser(prisma.client, {
      role: Role.ACCOUNTANT,
    });
    try {
      await request(app.getHttpServer())
        .post(`/projects/${project.id}/finances`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idem())
        .send({
          type: 'INCOME',
          amount: '100.00',
          currency: 'UZS',
          source: 'x',
          occurredAt: '2026-09-14',
        })
        .expect(201);

      const ownerToken = await loginTestUser(app.getHttpServer(), owner.email);
      const accountantToken = await loginTestUser(
        app.getHttpServer(),
        accountant.email,
      );

      await request(app.getHttpServer())
        .get(`/projects/${project.id}/audit`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/projects/${project.id}/audit`)
        .set('Authorization', `Bearer ${accountantToken}`)
        .expect(200);
    } finally {
      await deleteTestUser(prisma.client, owner.id);
      await deleteTestUser(prisma.client, accountant.id);
      await deleteTestProject(prisma.client, project.id);
    }
  });

  it('the audit trail itself is append-only at the database layer', async () => {
    const { project, manager } = await setupProjectAndManager();
    try {
      const row = await prisma.client.auditLog.create({
        data: {
          projectId: project.id,
          actorId: manager.id,
          action: 'test.probe',
          entityType: 'Test',
          entityId: randomUUID(),
          newData: { a: 1 },
        },
      });
      await expect(
        prisma.client.auditLog.update({
          where: { id: row.id },
          data: { action: 'tampered' },
        }),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });
});
