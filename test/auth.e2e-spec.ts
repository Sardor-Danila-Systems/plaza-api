import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Role } from '../src/generated/prisma/client.js';
import { setupApp } from '../src/setup-app.js';
import { CookieJar } from './cookie-jar.util.js';
import {
  TEST_PASSWORD,
  createTestUser,
  deleteTestUser,
} from './fixtures/auth.fixture.js';

/**
 * Full login -> me -> refresh -> logout lifecycle against the real REST
 * application and a real PostgreSQL database (docs/backend-architecture.md
 * §12) — no mocked Prisma, no mocked guards.
 */
describe('Auth (e2e)', () => {
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

  // Deliberately not `async`: supertest's `Test` is itself thenable AND
  // chainable (`.expect(...)`) — wrapping it in `async` would collapse it to
  // a plain `Promise<Response>` and lose `.expect()` at call sites.
  function loginAs(email: string, password: string) {
    return request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
  }

  describe('POST /auth/login', () => {
    it('succeeds with correct credentials, sets cookies, and never returns passwordHash', async () => {
      const user = await createTestUser(prisma.client);
      try {
        const response = await loginAs(user.email, TEST_PASSWORD).expect(200);

        expect(response.body.accessToken).toEqual(expect.any(String));
        expect(response.body.user).toEqual({
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          role: user.role,
          projectId: null,
        });
        expect(JSON.stringify(response.body)).not.toMatch(
          /passwordHash|argon2/i,
        );

        const setCookies = response.headers[
          'set-cookie'
        ] as unknown as string[];
        expect(
          setCookies.some(
            (c) => c.startsWith('refresh_token=') && c.includes('HttpOnly'),
          ),
        ).toBe(true);
        expect(
          setCookies.some(
            (c) => c.startsWith('csrf_token=') && !c.includes('HttpOnly'),
          ),
        ).toBe(true);
      } finally {
        await deleteTestUser(prisma.client, user.id);
      }
    });

    it('rejects an unknown email and a wrong password with the identical response', async () => {
      const user = await createTestUser(prisma.client);
      try {
        const unknownResponse = await loginAs(
          'definitely-not-registered@example.com',
          'whatever',
        ).expect(401);
        const wrongPasswordResponse = await loginAs(
          user.email,
          'the-wrong-password',
        ).expect(401);

        expect(unknownResponse.body.code).toBe('INVALID_CREDENTIALS');
        expect(wrongPasswordResponse.body.code).toBe('INVALID_CREDENTIALS');
        expect(unknownResponse.body.message).toBe(
          wrongPasswordResponse.body.message,
        );
        expect(unknownResponse.status).toBe(wrongPasswordResponse.status);
      } finally {
        await deleteTestUser(prisma.client, user.id);
      }
    });

    it('rejects a disabled user with a correct password using a distinct code', async () => {
      const user = await createTestUser(prisma.client, { isActive: false });
      try {
        const response = await loginAs(user.email, TEST_PASSWORD).expect(403);
        expect(response.body.code).toBe('USER_DISABLED');
      } finally {
        await deleteTestUser(prisma.client, user.id);
      }
    });

    it('rejects a malformed login request with 400 VALIDATION_ERROR', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'not-an-email', password: '' })
        .expect(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('normalizes email case/whitespace for login', async () => {
      const user = await createTestUser(prisma.client);
      try {
        await loginAs(`  ${user.email.toUpperCase()}  `, TEST_PASSWORD).expect(
          200,
        );
      } finally {
        await deleteTestUser(prisma.client, user.id);
      }
    });
  });

  describe('GET /auth/me', () => {
    it('returns the authenticated user for a valid access token', async () => {
      const user = await createTestUser(prisma.client, {
        role: Role.ACCOUNTANT,
      });
      try {
        const login = await loginAs(user.email, TEST_PASSWORD).expect(200);
        const response = await request(app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', `Bearer ${login.body.accessToken}`)
          .expect(200);

        expect(response.body).toEqual({
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          role: Role.ACCOUNTANT,
          projectId: null,
        });
      } finally {
        await deleteTestUser(prisma.client, user.id);
      }
    });

    it('rejects a missing token', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .expect(401);
      expect(response.body.code).toBe('UNAUTHENTICATED');
    });

    it('rejects a malformed/garbage token', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', 'Bearer not-a-real-jwt')
        .expect(401);
      expect(response.body.code).toBe('UNAUTHENTICATED');
    });

    it('rejects a token whose session no longer exists (e.g. a foreign/forged sid)', async () => {
      const user = await createTestUser(prisma.client);
      try {
        // A syntactically valid, correctly-signed-shaped bearer that simply
        // isn't a real token at all still exercises the "no session found"
        // path distinctly from "malformed" above only via a real forged JWT,
        // which requires the real secret — covered instead by the disabled/
        // revoked-session cases, which exercise the same guard branch.
        const login = await loginAs(user.email, TEST_PASSWORD).expect(200);
        await prisma.client.refreshSession.updateMany({
          where: { userId: user.id },
          data: { revokedAt: new Date(), revocationReason: 'TEST' },
        });
        const response = await request(app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', `Bearer ${login.body.accessToken}`)
          .expect(401);
        expect(response.body.code).toBe('UNAUTHENTICATED');
      } finally {
        await deleteTestUser(prisma.client, user.id);
      }
    });

    it('rejects a user disabled after the token was issued (per-request revalidation)', async () => {
      const user = await createTestUser(prisma.client);
      try {
        const login = await loginAs(user.email, TEST_PASSWORD).expect(200);
        await prisma.client.user.update({
          where: { id: user.id },
          data: { isActive: false },
        });

        const response = await request(app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', `Bearer ${login.body.accessToken}`)
          .expect(403);
        expect(response.body.code).toBe('USER_DISABLED');
      } finally {
        await prisma.client.user.update({
          where: { id: user.id },
          data: { isActive: true },
        });
        await deleteTestUser(prisma.client, user.id);
      }
    });
  });

  describe('POST /auth/refresh', () => {
    async function loginWithCookies(user: { email: string }) {
      const response = await loginAs(user.email, TEST_PASSWORD).expect(200);
      const jar = new CookieJar().absorb(response);
      return { response, jar };
    }

    it('rotates the refresh token and issues a new access token', async () => {
      const user = await createTestUser(prisma.client);
      try {
        const { jar } = await loginWithCookies(user);

        const refreshResponse = await request(app.getHttpServer())
          .post('/auth/refresh')
          .set('Cookie', jar.header())
          .set('X-CSRF-Token', jar.get('csrf_token')!)
          .expect(200);

        expect(refreshResponse.body.accessToken).toEqual(expect.any(String));
        const newJar = new CookieJar().absorb(refreshResponse);
        expect(newJar.get('refresh_token')).toBeDefined();
        expect(newJar.get('refresh_token')).not.toBe(jar.get('refresh_token'));
      } finally {
        await deleteTestUser(prisma.client, user.id);
      }
    });

    it('rejects reuse of an already-rotated refresh token and revokes the session', async () => {
      const user = await createTestUser(prisma.client);
      try {
        const { jar } = await loginWithCookies(user);
        const oldCookieHeader = jar.header();
        const oldCsrf = jar.get('csrf_token')!;

        await request(app.getHttpServer())
          .post('/auth/refresh')
          .set('Cookie', oldCookieHeader)
          .set('X-CSRF-Token', oldCsrf)
          .expect(200);

        const replay = await request(app.getHttpServer())
          .post('/auth/refresh')
          .set('Cookie', oldCookieHeader)
          .set('X-CSRF-Token', oldCsrf)
          .expect(401);
        expect(replay.body.code).toBe('REFRESH_TOKEN_REVOKED');
      } finally {
        await deleteTestUser(prisma.client, user.id);
      }
    });

    it('rejects a request with a mismatched/missing CSRF token', async () => {
      const user = await createTestUser(prisma.client);
      try {
        const { jar } = await loginWithCookies(user);

        const missing = await request(app.getHttpServer())
          .post('/auth/refresh')
          .set('Cookie', jar.header())
          .expect(403);
        expect(missing.body.code).toBe('CSRF_TOKEN_MISMATCH');

        const wrong = await request(app.getHttpServer())
          .post('/auth/refresh')
          .set('Cookie', jar.header())
          .set('X-CSRF-Token', 'not-the-real-csrf-token')
          .expect(403);
        expect(wrong.body.code).toBe('CSRF_TOKEN_MISMATCH');
      } finally {
        await deleteTestUser(prisma.client, user.id);
      }
    });

    it('rejects an unknown/garbage refresh token', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', 'refresh_token=not-a-real-token; csrf_token=abc')
        .set('X-CSRF-Token', 'abc')
        .expect(401);
      expect(response.body.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('rejects an expired refresh token', async () => {
      const user = await createTestUser(prisma.client);
      try {
        const { jar } = await loginWithCookies(user);
        await prisma.client.refreshToken.updateMany({
          where: { session: { userId: user.id } },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });

        const response = await request(app.getHttpServer())
          .post('/auth/refresh')
          .set('Cookie', jar.header())
          .set('X-CSRF-Token', jar.get('csrf_token')!)
          .expect(401);
        expect(response.body.code).toBe('TOKEN_EXPIRED');
      } finally {
        await deleteTestUser(prisma.client, user.id);
      }
    });

    it('rejects a refresh against a revoked session', async () => {
      const user = await createTestUser(prisma.client);
      try {
        const { jar } = await loginWithCookies(user);
        await prisma.client.refreshSession.updateMany({
          where: { userId: user.id },
          data: { revokedAt: new Date(), revocationReason: 'TEST' },
        });

        const response = await request(app.getHttpServer())
          .post('/auth/refresh')
          .set('Cookie', jar.header())
          .set('X-CSRF-Token', jar.get('csrf_token')!)
          .expect(401);
        expect(response.body.code).toBe('REFRESH_TOKEN_REVOKED');
      } finally {
        await deleteTestUser(prisma.client, user.id);
      }
    });

    it('rejects a refresh for a disabled user', async () => {
      const user = await createTestUser(prisma.client);
      try {
        const { jar } = await loginWithCookies(user);
        await prisma.client.user.update({
          where: { id: user.id },
          data: { isActive: false },
        });

        const response = await request(app.getHttpServer())
          .post('/auth/refresh')
          .set('Cookie', jar.header())
          .set('X-CSRF-Token', jar.get('csrf_token')!)
          .expect(403);
        expect(response.body.code).toBe('USER_DISABLED');
      } finally {
        await prisma.client.user.update({
          where: { id: user.id },
          data: { isActive: true },
        });
        await deleteTestUser(prisma.client, user.id);
      }
    });

    it('the stored token is a hash, never the raw secret', async () => {
      const user = await createTestUser(prisma.client);
      try {
        const { jar } = await loginWithCookies(user);
        const rawSecret = jar.get('refresh_token')!;

        const stored = await prisma.client.refreshToken.findMany({
          where: { session: { userId: user.id } },
        });
        expect(stored).toHaveLength(1);
        expect(stored[0].tokenHash).not.toBe(rawSecret);
        expect(stored[0].tokenHash).toMatch(/^[a-f0-9]{64}$/); // hex SHA-256
      } finally {
        await deleteTestUser(prisma.client, user.id);
      }
    });
  });

  describe('POST /auth/logout', () => {
    it('revokes the session: both the access token and the refresh token stop working immediately', async () => {
      const user = await createTestUser(prisma.client);
      try {
        const login = await loginAs(user.email, TEST_PASSWORD).expect(200);
        const jar = new CookieJar().absorb(login);

        await request(app.getHttpServer())
          .post('/auth/logout')
          .set('Authorization', `Bearer ${login.body.accessToken}`)
          .set('Cookie', jar.header())
          .set('X-CSRF-Token', jar.get('csrf_token')!)
          .expect(204);

        const meAfterLogout = await request(app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', `Bearer ${login.body.accessToken}`)
          .expect(401);
        expect(meAfterLogout.body.code).toBe('UNAUTHENTICATED');

        const refreshAfterLogout = await request(app.getHttpServer())
          .post('/auth/refresh')
          .set('Cookie', jar.header())
          .set('X-CSRF-Token', jar.get('csrf_token')!)
          .expect(401);
        expect(refreshAfterLogout.body.code).toBe('REFRESH_TOKEN_REVOKED');
      } finally {
        await deleteTestUser(prisma.client, user.id);
      }
    });

    it('requires authentication', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/logout')
        .expect(401);
      expect(response.body.code).toBe('UNAUTHENTICATED');
    });

    it('requires a matching CSRF token', async () => {
      const user = await createTestUser(prisma.client);
      try {
        const login = await loginAs(user.email, TEST_PASSWORD).expect(200);
        const jar = new CookieJar().absorb(login);

        const response = await request(app.getHttpServer())
          .post('/auth/logout')
          .set('Authorization', `Bearer ${login.body.accessToken}`)
          .set('Cookie', jar.header())
          .expect(403);
        expect(response.body.code).toBe('CSRF_TOKEN_MISMATCH');
      } finally {
        await deleteTestUser(prisma.client, user.id);
      }
    });
  });
});
