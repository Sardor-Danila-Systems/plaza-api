import {
  ArgumentsHost,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { jest } from '@jest/globals';
import { Prisma } from '../../generated/prisma/client.js';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

function createHost(
  overrides: { method?: string; originalUrl?: string; id?: string } = {},
) {
  const json = jest.fn<(body: Record<string, unknown>) => void>();
  const status = jest.fn().mockReturnValue({ json });
  const response = { status };
  const request = {
    method: overrides.method ?? 'GET',
    originalUrl: overrides.originalUrl ?? '/test',
    id: overrides.id ?? 'req-1',
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  return { host, status, json };
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
  });

  it('maps a plain HttpException to the stable error shape with a default code', () => {
    const { host, status, json } = createHost();

    filter.catch(new NotFoundException('Project not found'), host);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        error: 'Not Found',
        code: 'NOT_FOUND',
        message: 'Project not found',
        path: '/test',
        requestId: 'req-1',
      }),
    );
  });

  it('preserves an explicit business error code from the exception response body', () => {
    const { host, status, json } = createHost();

    filter.catch(
      new ForbiddenException({
        code: 'PROJECT_ACCESS_DENIED',
        message: 'nope',
      }),
      host,
    );

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 403,
        code: 'PROJECT_ACCESS_DENIED',
        message: 'nope',
      }),
    );
  });

  it('maps a Prisma unique constraint violation to 409 without leaking Prisma internals', () => {
    const { host, status, json } = createHost();
    const prismaError = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      {
        code: 'P2002',
        clientVersion: '7.10.0',
      },
    );

    filter.catch(prismaError, host);

    expect(status).toHaveBeenCalledWith(409);
    const body = json.mock.calls[0][0];
    expect(body.code).toBe('UNIQUE_CONSTRAINT_VIOLATION');
    expect(JSON.stringify(body)).not.toContain('Unique constraint failed');
  });

  it('maps a Prisma record-not-found error to 404', () => {
    const { host, status, json } = createHost();
    const prismaError = new Prisma.PrismaClientKnownRequestError(
      'No record found',
      {
        code: 'P2025',
        clientVersion: '7.10.0',
      },
    );

    filter.catch(prismaError, host);

    expect(status).toHaveBeenCalledWith(404);
    expect(json.mock.calls[0][0].code).toBe('RECORD_NOT_FOUND');
  });

  it('maps a Prisma transaction conflict to a retryable 409', () => {
    const { host, status, json } = createHost();
    const prismaError = new Prisma.PrismaClientKnownRequestError(
      'Transaction conflict',
      {
        code: 'P2034',
        clientVersion: '7.10.0',
      },
    );

    filter.catch(prismaError, host);

    expect(status).toHaveBeenCalledWith(409);
    expect(json.mock.calls[0][0].code).toBe('CONCURRENT_MODIFICATION');
  });

  it('never leaks a raw unclassified error message or stack to the client', () => {
    const { host, status, json } = createHost();

    filter.catch(
      new Error('super secret internal detail with a stack trace'),
      host,
    );

    expect(status).toHaveBeenCalledWith(500);
    const body = json.mock.calls[0][0];
    expect(body.code).toBe('INTERNAL_SERVER_ERROR');
    expect(JSON.stringify(body)).not.toContain('super secret internal detail');
  });
});
