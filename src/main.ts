import { LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { AppConfigService } from './config/app-config.service.js';
import { setupApp } from './setup-app.js';

const LOG_LEVELS_BY_VERBOSITY: LogLevel[] = [
  'error',
  'warn',
  'log',
  'debug',
  'verbose',
];

/**
 * Resolves the Nest bootstrap logger's level *before* the DI container (and
 * therefore full env validation via AppConfigService) exists. This is the one
 * place the application reads `process.env` directly instead of going
 * through validated config — there is no app yet to validate it with.
 * env.validation.ts still validates LOG_LEVEL fully once the app is created.
 */
function resolveBootstrapLogLevels(): LogLevel[] {
  const configured = process.env.LOG_LEVEL ?? 'log';
  const cutoff = LOG_LEVELS_BY_VERBOSITY.indexOf(configured as LogLevel);
  return cutoff === -1
    ? LOG_LEVELS_BY_VERBOSITY.slice(0, 3)
    : LOG_LEVELS_BY_VERBOSITY.slice(0, cutoff + 1);
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: resolveBootstrapLogLevels(),
  });

  setupApp(app);

  const config = app.get(AppConfigService);

  if (config.swaggerEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Euro Plaza Management System API')
        .setDescription(
          'Construction project management backend. See docs/backend-architecture.md ' +
            'for the module map, business invariants, and phased delivery plan.',
        )
        .setVersion('0.1.0')
        .addBearerAuth(
          { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          'access-token',
        )
        .addCookieAuth('refresh_token', {
          type: 'apiKey',
          in: 'cookie',
          description:
            'HttpOnly cookie set by POST /auth/login. POST /auth/refresh and ' +
            '/auth/logout also require the X-CSRF-Token header to match the ' +
            'non-HttpOnly csrf_token cookie (double-submit CSRF protection).',
        })
        .build(),
    );
    SwaggerModule.setup('docs', app, document);
  }

  await app.listen(config.port);
}

await bootstrap();
