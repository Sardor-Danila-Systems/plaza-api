import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { AppConfigService } from '../src/config/app-config.service.js';
import { setupApp } from '../src/setup-app.js';

/**
 * Proves the specific "database unavailable" contract from
 * docs/backend-architecture.md §3: the application must stay up and GET
 * /health must report the outage, not crash the process. Points at a real,
 * genuinely unreachable port (nothing listens on it) rather than mocking
 * Prisma, per docs/backend-architecture.md §12.
 */
describe('Health (e2e) — database unavailable', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AppConfigService)
      .useValue({
        nodeEnv: 'test',
        isProduction: false,
        isTest: true,
        port: 0,
        databaseUrl: 'postgresql://user:pass@127.0.0.1:1/unreachable',
        corsOrigins: [],
        swaggerEnabled: false,
        logLevel: 'error',
      })
      .compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    setupApp(app);
    // Intentionally NOT awaiting failure here: app.init() must succeed even
    // though the database is unreachable (see PrismaService.onModuleInit).
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('stays up and starts successfully even though the database is unreachable', () => {
    expect(app).toBeDefined();
  });

  it('GET /health returns 503 with a safe, generic message', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(503);

    expect(response.body).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      code: 'DATABASE_UNAVAILABLE',
      message: 'Database connection failed',
      path: '/health',
      timestamp: expect.any(String),
      requestId: expect.any(String),
    });
  });

  it('never leaks the connection string or driver error details', async () => {
    const response = await request(app.getHttpServer()).get('/health');
    expect(JSON.stringify(response.body)).not.toMatch(
      /127\.0\.0\.1|unreachable|ECONNREFUSED/,
    );
  });
});
