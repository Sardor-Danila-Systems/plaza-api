import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { setupApp } from '../src/setup-app.js';
import { CookieJar } from './cookie-jar.util.js';
import {
  TEST_PASSWORD,
  createTestUser,
  deleteTestUser,
} from './fixtures/auth.fixture.js';

/**
 * The concurrency scenario Phase 2 §27 requires: two simultaneous refresh
 * requests presenting the SAME refresh token. Exactly one must succeed; the
 * other must fail; no duplicate active token may survive. Run against real
 * PostgreSQL (docs/backend-architecture.md §12) — this is exactly the kind
 * of race a mocked Prisma client could not prove safe.
 */
describe('Auth refresh concurrency (e2e)', () => {
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

  it('lets exactly one of two simultaneous refresh requests (same token) succeed', async () => {
    const user = await createTestUser(prisma.client);
    try {
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(200);
      const jar = new CookieJar().absorb(login);
      const cookieHeader = jar.header();
      const csrf = jar.get('csrf_token')!;

      const [first, second] = await Promise.all([
        request(app.getHttpServer())
          .post('/auth/refresh')
          .set('Cookie', cookieHeader)
          .set('X-CSRF-Token', csrf),
        request(app.getHttpServer())
          .post('/auth/refresh')
          .set('Cookie', cookieHeader)
          .set('X-CSRF-Token', csrf),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 401]);

      const winner = first.status === 200 ? first : second;
      const loser = first.status === 200 ? second : first;
      expect(winner.body.accessToken).toEqual(expect.any(String));
      expect(loser.body.code).toBe('REFRESH_TOKEN_REVOKED');

      // Per docs/adr/0012-refresh-rotation-concurrency.md, the loser is
      // treated identically to a delayed-replay attacker (industry-standard
      // OAuth2 refresh-rotation reuse detection: ANY reuse of a consumed
      // token burns the whole session, since a race and an attack are not
      // reliably distinguishable from the server's side). This means the
      // "winner" of the race does NOT end up with a durably usable session
      // either — both requests ultimately lose the token. Clients must
      // never fire two refresh requests concurrently for the same token
      // (a single-flight/mutex guard around refresh calls, standard
      // practice in frontend auth libraries) — this test's job is to prove
      // the server-side invariant (no duplicate active token, ever), not to
      // make concurrent refresh calls a supported client pattern.
      const session = await prisma.client.refreshSession.findFirstOrThrow({
        where: { userId: user.id },
      });
      expect(session.revokedAt).not.toBeNull();
      expect(session.revocationReason).toBe('REFRESH_TOKEN_REUSE_DETECTED');

      const tokens = await prisma.client.refreshToken.findMany({
        where: { sessionId: session.id },
      });
      const unconsumed = tokens.filter((t) => t.consumedAt === null);
      // No unconsumed token is left *active* (the winner's new token exists
      // but its session is revoked) — assert no duplicate ACTIVE session
      // survives by checking the winner's token can no longer be used.
      expect(unconsumed.length).toBeLessThanOrEqual(1);
      expect(tokens).toHaveLength(2); // the original (consumed) + the winner's new one

      // The session was revoked as a side effect of the detected reuse, so
      // even the winner's freshly-issued token is now unusable.
      const winnerJar = new CookieJar().absorb(winner);
      const followUp = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', winnerJar.header())
        .set('X-CSRF-Token', winnerJar.get('csrf_token')!);
      expect(followUp.status).toBe(401);
      expect(followUp.body.code).toBe('REFRESH_TOKEN_REVOKED');
    } finally {
      await deleteTestUser(prisma.client, user.id);
    }
  });
});
