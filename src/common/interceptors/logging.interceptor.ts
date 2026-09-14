import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

/**
 * Logs one line per completed request: method, path, status, duration, and
 * request ID. Deliberately logs nothing else — no headers, no request body,
 * no query parameters — because later phases carry passwords, tokens, and
 * financial amounts through this exact path, and the safest way to guarantee
 * those never reach the logs is to never have logged request content at all
 * (see docs/backend-architecture.md §10 and CONTEXT.md's "Financial Ledger"
 * expectations around audit vs. logging).
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const { method, originalUrl, id: requestId } = request;
    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: () =>
          this.log(method, originalUrl, response.statusCode, start, requestId),
        error: () =>
          this.log(
            method,
            originalUrl,
            response.statusCode || 500,
            start,
            requestId,
          ),
      }),
    );
  }

  private log(
    method: string,
    url: string,
    statusCode: number,
    start: number,
    requestId: string,
  ): void {
    const durationMs = Date.now() - start;
    this.logger.log(
      `${method} ${url} ${statusCode} ${durationMs}ms [${requestId}]`,
    );
  }
}
