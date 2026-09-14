import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/setup-app.js';

/**
 * Runs the real REST application (real Nest DI graph, real global pipes /
 * filters / middleware via setupApp, real PostgreSQL through PrismaService)
 * per docs/backend-architecture.md §12 — Prisma is never mocked here.
 * Requires TEST_DATABASE_URL (see README "Tests"); NODE_ENV=test (set by
 * Jest automatically) makes ConfigModule load .env.test.
 */
describe('Health (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    setupApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns 200 with the exact documented shape when the database is up', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(200);

    expect(response.body).toEqual({
      status: 'ok',
      database: 'up',
      timestamp: expect.any(String),
    });
    expect(new Date(response.body.timestamp).toString()).not.toBe(
      'Invalid Date',
    );
  });

  it('echoes a caller-supplied X-Request-Id and includes it in the body on error responses', async () => {
    const okResponse = await request(app.getHttpServer())
      .get('/health')
      .set('X-Request-Id', 'test-request-id-123')
      .expect(200);
    expect(okResponse.headers['x-request-id']).toBe('test-request-id-123');

    const notFound = await request(app.getHttpServer())
      .get('/does-not-exist')
      .set('X-Request-Id', 'test-request-id-456')
      .expect(404);
    expect(notFound.body.requestId).toBe('test-request-id-456');
    expect(notFound.headers['x-request-id']).toBe('test-request-id-456');
  });

  it('generates a request ID when the caller does not supply one', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(200);
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.headers['x-request-id'].length).toBeGreaterThan(0);
  });

  it('GET /nonexistent-route returns the stable error response shape', async () => {
    const response = await request(app.getHttpServer())
      .get('/nonexistent-route')
      .expect(404);

    expect(response.body).toEqual({
      statusCode: 404,
      error: 'Not Found',
      code: 'NOT_FOUND',
      message: expect.any(String),
      path: '/nonexistent-route',
      timestamp: expect.any(String),
      requestId: expect.any(String),
    });
  });

  it('never leaks Prisma/SQL details or a stack trace in any response body', async () => {
    const response = await request(app.getHttpServer()).get('/health');
    expect(JSON.stringify(response.body)).not.toMatch(
      /postgres|prisma|at .*\.ts:\d+/i,
    );
  });

  it('applies security headers (helmet) to every response', async () => {
    const response = await request(app.getHttpServer()).get('/health');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('rejects a cross-origin request by default (no CORS_ORIGIN configured)', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .set('Origin', 'https://not-an-approved-origin.example');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
