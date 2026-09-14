import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { jest } from '@jest/globals';
import { Role } from '../../../generated/prisma/client.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

/**
 * Unit-level: exercises the guard's own branching in isolation with a fake
 * Prisma/token layer. The real per-request DB revalidation behavior (the
 * actual point of docs/adr/0009-per-request-session-revalidation.md) is
 * proven against real PostgreSQL in test/auth.e2e-spec.ts — this test is
 * about the guard's decision logic reacting correctly to each case, not
 * about re-proving the database round trip.
 */
function createContext(overrides: { authorization?: string } = {}): {
  context: ExecutionContext;
  request: { headers: Record<string, string>; user?: unknown };
} {
  const request: { headers: Record<string, string>; user?: unknown } = {
    headers: overrides.authorization
      ? { authorization: overrides.authorization }
      : {},
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('JwtAuthGuard', () => {
  const validPayload = { sub: 'user-1', sid: 'session-1', role: Role.OWNER };
  const activeSession: {
    id: string;
    revokedAt: Date | null;
    expiresAt: Date;
    user: {
      id: string;
      email: string;
      displayName: string;
      role: Role;
      projectId: string | null;
      isActive: boolean;
    };
  } = {
    id: 'session-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    user: {
      id: 'user-1',
      email: 'user@example.com',
      displayName: 'User',
      role: Role.OWNER,
      projectId: null,
      isActive: true,
    },
  };

  function buildGuard(options: {
    isPublic?: boolean;
    verify?: () => Promise<typeof validPayload>;
    // 'session' explicitly absent from `options` means "use the default
    // active session"; `session: null` means "simulate none found" — these
    // must stay distinguishable, so no `??` here.
    session?: typeof activeSession | null;
  }) {
    const resolvedSession =
      'session' in options ? options.session : activeSession;
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(options.isPublic ?? false),
    };
    const tokenService = {
      verifyAccessToken:
        options.verify ?? jest.fn(() => Promise.resolve(validPayload)),
    };
    const prisma = {
      client: {
        refreshSession: {
          findUnique: jest.fn(() => Promise.resolve(resolvedSession)),
        },
      },
    };
    return new JwtAuthGuard(
      reflector as unknown as Reflector,
      tokenService as never,
      prisma as never,
    );
  }

  it('allows a @Public() route without checking any token', async () => {
    const guard = buildGuard({ isPublic: true });
    const { context } = createContext();
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('rejects a missing Authorization header', async () => {
    const guard = buildGuard({});
    const { context } = createContext();
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'UNAUTHENTICATED' },
    });
  });

  it('rejects a header that is not a Bearer token', async () => {
    const guard = buildGuard({});
    const { context } = createContext({ authorization: 'Basic abc123' });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('maps a TokenExpiredError to TOKEN_EXPIRED', async () => {
    const expiredError = Object.assign(new Error('jwt expired'), {
      name: 'TokenExpiredError',
    });
    const guard = buildGuard({ verify: () => Promise.reject(expiredError) });
    const { context } = createContext({ authorization: 'Bearer x' });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'TOKEN_EXPIRED' },
    });
  });

  it('maps any other verification failure to UNAUTHENTICATED, never the raw library error', async () => {
    const guard = buildGuard({
      verify: () => Promise.reject(new Error('jwt malformed')),
    });
    const { context } = createContext({ authorization: 'Bearer x' });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: {
        code: 'UNAUTHENTICATED',
        message: expect.not.stringContaining('jwt malformed'),
      },
    });
  });

  it('rejects when the session no longer exists', async () => {
    const guard = buildGuard({ session: null });
    const { context } = createContext({ authorization: 'Bearer x' });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'UNAUTHENTICATED' },
    });
  });

  it('rejects a revoked session', async () => {
    const guard = buildGuard({
      session: { ...activeSession, revokedAt: new Date() },
    });
    const { context } = createContext({ authorization: 'Bearer x' });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'UNAUTHENTICATED' },
    });
  });

  it('rejects an expired session', async () => {
    const guard = buildGuard({
      session: { ...activeSession, expiresAt: new Date(Date.now() - 1000) },
    });
    const { context } = createContext({ authorization: 'Bearer x' });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'UNAUTHENTICATED' },
    });
  });

  it('rejects a disabled user with USER_DISABLED, not UNAUTHENTICATED', async () => {
    const guard = buildGuard({
      session: {
        ...activeSession,
        user: { ...activeSession.user, isActive: false },
      },
    });
    const { context } = createContext({ authorization: 'Bearer x' });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'USER_DISABLED' },
    });
  });

  it('attaches the authenticated user to the request on success', async () => {
    const guard = buildGuard({});
    const { context, request } = createContext({ authorization: 'Bearer x' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({
      id: 'user-1',
      email: 'user@example.com',
      displayName: 'User',
      role: Role.OWNER,
      projectId: null,
      sessionId: 'session-1',
    });
  });
});
