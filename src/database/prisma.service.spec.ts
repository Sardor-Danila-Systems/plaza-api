import { Test } from '@nestjs/testing';
import { AppConfigService } from '../config/app-config.service.js';
import { PrismaService } from './prisma.service.js';

describe('PrismaService', () => {
  it('is instantiable through Nest DI without connecting to a database', async () => {
    // No .init() call: this is a wiring/unit test, not an integration test.
    // Lifecycle hooks (onModuleInit's $connect) intentionally never run here
    // — that would require a real database, which belongs in the e2e suite
    // (test/health.e2e-spec.ts) per docs/backend-architecture.md §12's "real
    // PostgreSQL for transaction-critical tests" rule.
    const moduleRef = await Test.createTestingModule({
      providers: [
        PrismaService,
        {
          provide: AppConfigService,
          useValue: { databaseUrl: 'postgresql://user:pass@localhost:5432/db' },
        },
      ],
    }).compile();

    const service = moduleRef.get(PrismaService);
    expect(service).toBeInstanceOf(PrismaService);
    // See docs/adr/0007: PrismaService composes the generated client rather
    // than extending it, so `.client` (not the service itself) exposes the
    // model delegates / $transaction / $queryRaw surface.
    expect(typeof service.client.$connect).toBe('function');
  });
});
