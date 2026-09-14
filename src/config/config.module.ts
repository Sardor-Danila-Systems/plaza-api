import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { AppConfigService } from './app-config.service.js';
import { validate } from './env.validation.js';

/**
 * Global so every feature module can inject AppConfigService without
 * re-importing this module — environment configuration is infrastructure,
 * not a per-feature concern.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      validate,
      // .env.test is loaded first (and wins) when NODE_ENV=test is already
      // set in the process environment (e.g. by the Jest test setup), falling
      // back to .env for development. Real deployments set environment
      // variables directly and do not ship an .env file at all.
      envFilePath:
        process.env.NODE_ENV === 'test' ? ['.env.test', '.env'] : ['.env'],
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class ConfigModule {}
