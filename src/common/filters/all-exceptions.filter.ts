import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '../../generated/prisma/client.js';

interface ErrorBody {
  statusCode: number;
  error: string;
  code: string;
  message: string | string[];
  path: string;
  timestamp: string;
  requestId: string;
}

/**
 * The one place raw errors are turned into the stable response shape from
 * docs/backend-architecture.md §9 (`{ code, message, ... }`). Nothing else in
 * the application should catch-and-reformat an exception — business code
 * throws a Nest `HttpException` (optionally with `{ code, message }` as its
 * response body for a stable business error code) and lets this filter do
 * the rest. Never leaks a Prisma/SQL message, a stack trace, or any
 * exception's raw `.message` for anything this filter doesn't explicitly
 * recognize (see docs/backend-architecture.md §9 "never return Prisma
 * messages, SQL, stack traces...").
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionsFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { statusCode, error, code, message } = this.resolve(exception);

    if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.originalUrl} -> ${statusCode} [${request.id}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ErrorBody = {
      statusCode,
      error,
      code,
      message,
      path: request.originalUrl,
      timestamp: new Date().toISOString(),
      requestId: request.id,
    };

    response.status(statusCode).json(body);
  }

  private resolve(exception: unknown): {
    statusCode: number;
    error: string;
    code: string;
    message: string | string[];
  } {
    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }

    const prismaError = this.fromPrismaError(exception);
    if (prismaError) {
      return prismaError;
    }

    // Anything else (a plain thrown Error, a programming bug) is an
    // unclassified server fault. The real message/stack goes to the log
    // above, never to the client.
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Internal Server Error',
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    };
  }

  private fromHttpException(exception: HttpException): {
    statusCode: number;
    error: string;
    code: string;
    message: string | string[];
  } {
    const statusCode = exception.getStatus();
    const response = exception.getResponse();
    const error = HttpStatus[statusCode]
      ? this.titleCase(HttpStatus[statusCode])
      : exception.name;

    if (typeof response === 'string') {
      return {
        statusCode,
        error,
        code: this.defaultCode(statusCode),
        message: response,
      };
    }

    const body = response as Record<string, unknown>;
    const message =
      (body.message as string | string[] | undefined) ?? exception.message;
    const code =
      typeof body.code === 'string' ? body.code : this.defaultCode(statusCode);

    return { statusCode, error, code, message };
  }

  /**
   * Maps the small set of Prisma error conditions Phase 1 owns (see
   * docs/backend-architecture.md §7: unique constraint, record-not-found,
   * foreign-key conflict, transaction conflict). Business-specific meaning
   * for these (e.g. "which unique field", "INSUFFICIENT_STOCK") belongs to
   * the module that triggers them in later phases — this mapping only
   * guarantees a raw Prisma error can never reach a client unmapped.
   */
  private fromPrismaError(exception: unknown): {
    statusCode: number;
    error: string;
    code: string;
    message: string | string[];
  } | null {
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          return {
            statusCode: HttpStatus.CONFLICT,
            error: 'Conflict',
            code: 'UNIQUE_CONSTRAINT_VIOLATION',
            message: 'A record with this value already exists',
          };
        case 'P2025':
          return {
            statusCode: HttpStatus.NOT_FOUND,
            error: 'Not Found',
            code: 'RECORD_NOT_FOUND',
            message: 'The requested record does not exist',
          };
        case 'P2003':
          return {
            statusCode: HttpStatus.CONFLICT,
            error: 'Conflict',
            code: 'FOREIGN_KEY_CONSTRAINT_VIOLATION',
            message: 'This operation references a record that does not exist',
          };
        case 'P2034':
          return {
            statusCode: HttpStatus.CONFLICT,
            error: 'Conflict',
            code: 'CONCURRENT_MODIFICATION',
            message:
              'This operation conflicted with a concurrent change; please retry',
          };
        default:
          return {
            statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
            error: 'Internal Server Error',
            code: 'DATABASE_ERROR',
            message: 'An unexpected database error occurred',
          };
      }
    }

    if (
      exception instanceof Prisma.PrismaClientValidationError ||
      exception instanceof Prisma.PrismaClientUnknownRequestError ||
      exception instanceof Prisma.PrismaClientInitializationError ||
      exception instanceof Prisma.PrismaClientRustPanicError
    ) {
      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        error: 'Internal Server Error',
        code: 'DATABASE_ERROR',
        message: 'An unexpected database error occurred',
      };
    }

    return null;
  }

  private defaultCode(statusCode: number): string {
    switch (statusCode) {
      case HttpStatus.BAD_REQUEST:
        return 'VALIDATION_ERROR';
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHENTICATED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'CONFLICT';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'TOO_MANY_REQUESTS';
      default:
        return statusCode >= 500
          ? 'INTERNAL_SERVER_ERROR'
          : `HTTP_${statusCode}`;
    }
  }

  private titleCase(constantName: string): string {
    return constantName
      .split('_')
      .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
      .join(' ');
  }
}
