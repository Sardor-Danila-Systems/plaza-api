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
 * Real subdomain-split deployments (frontend on app.example.com, API on
 * api.example.com) are DIFFERENT HOSTS, not just different ports of the
 * same host — the local-dev "port is ignored" cookie-scoping trick
 * (RFC 6265) does not apply between them. Without an explicit `Domain`
 * attribute, refresh_token/csrf_token are host-only (visible only to
 * api.example.com), so the frontend's own CSRF-bridge mechanism can never
 * read `csrf_token`, `/auth/refresh` always 403s on a missing CSRF header,
 * and every page reload logs the user out. This is a dedicated app
 * instance (not the main auth.e2e-spec.ts one) specifically so
 * COOKIE_DOMAIN can be set in `process.env` before ConfigModule reads it,
 * without affecting every other e2e suite.
 */
describe('Auth cookies with COOKIE_DOMAIN set (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const COOKIE_DOMAIN = '.example.com';

  beforeAll(async () => {
    process.env.COOKIE_DOMAIN = COOKIE_DOMAIN;

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
    delete process.env.COOKIE_DOMAIN;
  });

  it('login sets refresh_token and csrf_token with the configured Domain attribute', async () => {
    const user = await createTestUser(prisma.client);
    try {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(200);

      const setCookies = response.headers['set-cookie'] as unknown as string[];
      expect(
        setCookies.some(
          (c) =>
            c.startsWith('refresh_token=') &&
            c.includes(`Domain=${COOKIE_DOMAIN}`),
        ),
      ).toBe(true);
      expect(
        setCookies.some(
          (c) =>
            c.startsWith('csrf_token=') &&
            c.includes(`Domain=${COOKIE_DOMAIN}`),
        ),
      ).toBe(true);
    } finally {
      await deleteTestUser(prisma.client, user.id);
    }
  });

  it('logout clears both cookies using the same Domain attribute they were set with', async () => {
    const user = await createTestUser(prisma.client);
    try {
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(200);
      const jar = new CookieJar().absorb(login);

      const logout = await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .set('Cookie', jar.header())
        .set('X-CSRF-Token', jar.get('csrf_token')!)
        .expect(204);

      const clearCookies = logout.headers['set-cookie'] as unknown as string[];
      expect(
        clearCookies.some(
          (c) =>
            c.startsWith('refresh_token=') &&
            c.includes(`Domain=${COOKIE_DOMAIN}`),
        ),
      ).toBe(true);
      expect(
        clearCookies.some(
          (c) =>
            c.startsWith('csrf_token=') &&
            c.includes(`Domain=${COOKIE_DOMAIN}`),
        ),
      ).toBe(true);
    } finally {
      await deleteTestUser(prisma.client, user.id);
    }
  });
});
