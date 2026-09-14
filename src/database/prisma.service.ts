import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { AppConfigService } from '../config/app-config.service.js';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Thin Nest lifecycle wrapper around the generated Prisma client, exposed via
 * composition (`prismaService.client`) rather than the classic
 * `class PrismaService extends PrismaClient` pattern from Prisma 5/6-era
 * NestJS tutorials.
 *
 * This is a deliberate, empirically-verified choice, not a style preference:
 * Prisma ORM v7's generated `PrismaClient` (`$Class.getPrismaClientClass()`)
 * returns an instance whose constructor does not preserve subclass identity —
 * `new (class Sub extends PrismaClient {})() instanceof Sub` is `false`. See
 * docs/adr/0007-prisma-client-composition-not-inheritance.md for the
 * verification and docs/phase-0-review.md's Phase 1 addendum. Business
 * services inject `PrismaService` and call `this.prisma.client.$transaction`
 * / `this.prisma.client.<model>` — still "controller -> service -> Prisma"
 * with no repository layer (docs/backend-architecture.md §6), just one extra
 * `.client` property access.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /** The real Prisma client. Business services call `this.prisma.client.*`. */
  readonly client: PrismaClient;

  constructor(config: AppConfigService) {
    // Prisma ORM v7 requires an explicit driver adapter for PostgreSQL — see
    // docs/phase-0-review.md for the version research behind this. The
    // connection string itself was already validated at startup by
    // src/config/env.validation.ts; this constructor never logs it.
    //
    // 'query'-level logging is intentionally never enabled: later phases pass
    // real money/quantity values as query parameters, and Prisma's query log
    // can include them — that would violate the "no sensitive values in
    // logs" rule in docs/backend-architecture.md §10 the moment it's turned on.
    this.client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: config.databaseUrl }),
      log: ['warn', 'error'],
    });
  }

  async onModuleInit(): Promise<void> {
    // Deliberately does not rethrow: a transient database outage at boot
    // should not crash-loop the whole application when GET /health exists
    // specifically to keep reporting that outage while the process stays up
    // (see docs/backend-architecture.md §3 "Database Health" and the Phase 1
    // report's "deviations" section for the reasoning). Config *validity*
    // (DATABASE_URL is a well-formed postgres:// URL) is still enforced at
    // startup by src/config/env.validation.ts and does cause a fast failure;
    // this only concerns the database's live reachability.
    try {
      await this.client.$connect();
      this.logger.log('Database connection established');
    } catch (error) {
      this.logger.error(
        'Database connection failed at startup; the application will keep ' +
          'running and GET /health will report it as unavailable until the ' +
          'database becomes reachable',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
    this.logger.log('Database connection closed');
  }
}
