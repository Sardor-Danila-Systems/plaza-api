import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    /** Correlates this request across logs, error responses, and (from
     * Phase 9 onward) the audit trail. See docs/backend-architecture.md §10. */
    id: string;
  }
}

const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Assigns every request a request ID — reusing an inbound `X-Request-Id`
 * header if the caller/gateway already set one, otherwise generating a fresh
 * one — and echoes it back on the response. LoggingInterceptor and
 * AllExceptionsFilter both read `req.id` so a single request's log line and
 * its error response (if any) always carry the same identifier.
 *
 * Wired via `app.use()` in main.ts rather than Nest's
 * `MiddlewareConsumer.forRoutes()`: this must run for literally every
 * request, including ones that match no controller (a plain 404) — Express 5
 * (this project's platform) also removed the bare `'*'` wildcard route
 * pattern that `forRoutes('*')` would otherwise rely on.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const inbound = req.headers[REQUEST_ID_HEADER];
  req.id = (Array.isArray(inbound) ? inbound[0] : inbound) || randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}
