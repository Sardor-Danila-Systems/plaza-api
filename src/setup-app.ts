import cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppConfigService } from './config/app-config.service.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor.js';
import { requestIdMiddleware } from './common/middleware/request-id.middleware.js';

const BODY_SIZE_LIMIT = '1mb';

/**
 * Applies every process-wide concern (middleware, pipes, filters,
 * interceptors, CORS, shutdown hooks) that both the real `main.ts` bootstrap
 * and the e2e test suite need identically. Extracted specifically so e2e
 * tests exercise the real production request pipeline instead of a
 * hand-rolled subset that could silently drift from it — see
 * docs/backend-architecture.md §12's "use the real REST application"
 * testing requirement. Swagger is intentionally NOT set up here: it is a
 * docs-serving concern with no effect on request handling, so main.ts wires
 * it separately and tests never need it running.
 */
export function setupApp(app: NestExpressApplication): void {
  const config = app.get(AppConfigService);

  app.use(requestIdMiddleware);
  app.use(helmet());
  app.use(json({ limit: BODY_SIZE_LIMIT }));
  app.use(urlencoded({ extended: true, limit: BODY_SIZE_LIMIT }));
  // Not given a secret: the refresh-token cookie's own value IS the secret
  // (a high-entropy random token, hashed at rest), and the CSRF cookie's
  // security comes from the double-submit comparison, not from the cookie
  // being tamper-evident — see csrf.guard.ts and auth.constants.ts.
  app.use(cookieParser());

  const corsOrigins = config.corsOrigins;
  app.enableCors(
    corsOrigins.length > 0
      ? { origin: corsOrigins, credentials: true }
      : { origin: false },
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      exceptionFactory: (errors) =>
        new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: errors
            .flatMap((error) => Object.values(error.constraints ?? {}))
            .filter((message): message is string => Boolean(message)),
        }),
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());
  app.enableShutdownHooks();
}
