import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Role } from '../src/generated/prisma/client.js';
import { ProjectLockService } from '../src/database/project-lock.service.js';
import { setupApp } from '../src/setup-app.js';
import {
  createTestProject,
  createTestUser,
  deleteTestProject,
  loginTestUser,
} from './fixtures/auth.fixture.js';

/**
 * The project-lock/Serializable/retry protocol under genuine concurrent
 * load, against real PostgreSQL — docs/transaction-design.md §1-2 and the
 * invariant matrix rows for concurrency (never a mocked Prisma client, per
 * docs/backend-architecture.md §12). A bug in the retry classification, the
 * balance check's placement inside the lock, or the idempotency race
 * handling would surface here as either a corrupted final balance, more
 * than one row created for one idempotency key, or a raw 500 from an
 * unhandled serialization failure — not just as a logical assertion
 * failure, since the requests genuinely execute concurrently.
 */
describe('Finances concurrency (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let projectLock: ProjectLockService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    projectLock = app.get(ProjectLockService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function setupProjectAndManager() {
    const project = await createTestProject(
      prisma.client,
      `Concurrency Test ${randomUUID()}`,
    );
    const manager = await createTestUser(prisma.client, {
      role: Role.PROJECT_MANAGER,
      projectId: project.id,
    });
    const token = await loginTestUser(app.getHttpServer(), manager.email);
    return { project, manager, token };
  }

  it('lets exactly one of two concurrent EXPENSEs succeed when only one can be afforded', async () => {
    const { project, token } = await setupProjectAndManager();
    try {
      await request(app.getHttpServer())
        .post(`/projects/${project.id}/finances`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          type: 'INCOME',
          amount: '100.00',
          currency: 'UZS',
          source: 'x',
          occurredAt: '2026-09-14',
        })
        .expect(201);

      const [a, b] = await Promise.all([
        request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', randomUUID())
          .send({
            type: 'EXPENSE',
            amount: '100.00',
            currency: 'UZS',
            recipient: 'a',
            occurredAt: '2026-09-14',
          }),
        request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', randomUUID())
          .send({
            type: 'EXPENSE',
            amount: '100.00',
            currency: 'UZS',
            recipient: 'b',
            occurredAt: '2026-09-14',
          }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);
      const rejected = a.status === 409 ? a : b;
      expect(rejected.body.code).toBe('INSUFFICIENT_CASH');

      const balance = await request(app.getHttpServer())
        .get(`/projects/${project.id}/finances/balance`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(balance.body.uzs).toBe('0.00');

      const expenseCount = await prisma.client.financialTransaction.count({
        where: { projectId: project.id, type: 'EXPENSE' },
      });
      expect(expenseCount).toBe(1);
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  }, 20000);

  it('creates exactly one operation for N concurrent requests sharing the same idempotency key and payload', async () => {
    const { project, token } = await setupProjectAndManager();
    try {
      const key = randomUUID();
      const payload = {
        type: 'INCOME',
        amount: '50.00',
        currency: 'UZS',
        source: 'x',
        occurredAt: '2026-09-14',
      };

      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app.getHttpServer())
            .post(`/projects/${project.id}/finances`)
            .set('Authorization', `Bearer ${token}`)
            .set('Idempotency-Key', key)
            .send(payload),
        ),
      );

      for (const response of responses) {
        expect([200, 201]).toContain(response.status);
      }
      const ids = new Set(responses.map((r) => r.body.id));
      expect(ids.size).toBe(1);
      // Exactly one of the five got 201; the rest replayed with 200.
      expect(responses.filter((r) => r.status === 201)).toHaveLength(1);

      const count = await prisma.client.financialTransaction.count({
        where: { projectId: project.id },
      });
      expect(count).toBe(1);
      const opCount = await prisma.client.postedOperation.count({
        where: { projectId: project.id },
      });
      expect(opCount).toBe(1);
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  }, 20000);

  it('ProjectLockService.runExclusive serializes concurrent attempts on the same project without corrupting postingSequence', async () => {
    const project = await createTestProject(
      prisma.client,
      `Lock Test ${randomUUID()}`,
    );
    try {
      const attempts = 10;
      const settled = await Promise.allSettled(
        Array.from({ length: attempts }, () =>
          projectLock.runExclusive(project.id, async (tx) => {
            const sequence = await projectLock.bumpPostingSequence(
              tx,
              project.id,
            );
            return sequence;
          }),
        ),
      );

      // The protocol's actual guarantee (docs/transaction-design.md §2): at
      // most MAX_ATTEMPTS (3) retries per call, so under enough concurrent
      // contention some calls legitimately exhaust their retries and
      // surface 409 CONCURRENT_MODIFICATION — that is correct, bounded
      // behavior, not a bug. What must never happen is silent corruption:
      // every fulfilled result's sequence number is unique, and the
      // project's final postingSequence equals exactly the number of calls
      // that actually succeeded — never more (double-counting) and never
      // less (a lost increment), and no result is a raw/unhandled error.
      const fulfilled = settled.filter(
        (r): r is PromiseFulfilledResult<bigint> => r.status === 'fulfilled',
      );
      const rejected = settled.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(fulfilled.length + rejected.length).toBe(attempts);
      for (const failure of rejected) {
        expect(failure.reason).toMatchObject({
          response: { code: 'CONCURRENT_MODIFICATION' },
        });
      }
      const sequenceValues = fulfilled.map((r) => r.value.toString());
      expect(new Set(sequenceValues).size).toBe(fulfilled.length);

      const finalProject = await prisma.client.project.findUniqueOrThrow({
        where: { id: project.id },
      });
      expect(finalProject.postingSequence.toString()).toBe(
        fulfilled.length.toString(),
      );
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  }, 20000);

  it('returns 409 CONCURRENT_MODIFICATION only as a last resort, never data corruption, under heavy contention', async () => {
    const { project, token } = await setupProjectAndManager();
    try {
      await request(app.getHttpServer())
        .post(`/projects/${project.id}/finances`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          type: 'INCOME',
          amount: '10000.00',
          currency: 'UZS',
          source: 'x',
          occurredAt: '2026-09-14',
        })
        .expect(201);

      const concurrency = 8;
      const responses = await Promise.all(
        Array.from({ length: concurrency }, () =>
          request(app.getHttpServer())
            .post(`/projects/${project.id}/finances`)
            .set('Authorization', `Bearer ${token}`)
            .set('Idempotency-Key', randomUUID())
            .send({
              type: 'EXPENSE',
              amount: '100.00',
              currency: 'UZS',
              recipient: 'x',
              occurredAt: '2026-09-14',
            }),
        ),
      );

      // Every response must be a well-formed outcome — 201 (posted) or 409
      // (insufficient cash, or exhausted retries) — never a raw 500.
      for (const response of responses) {
        expect([201, 409]).toContain(response.status);
      }

      const succeeded = responses.filter((r) => r.status === 201).length;
      const expenseCount = await prisma.client.financialTransaction.count({
        where: { projectId: project.id, type: 'EXPENSE' },
      });
      expect(expenseCount).toBe(succeeded);

      const balance = await request(app.getHttpServer())
        .get(`/projects/${project.id}/finances/balance`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const expectedBalance = (10000 - succeeded * 100).toFixed(2);
      expect(balance.body.uzs).toBe(expectedBalance);
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  }, 20000);
});
