import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { jest } from '@jest/globals';
import { Role } from '../../../generated/prisma/client.js';
import { AuthenticatedUser } from '../types/authenticated-user.js';
import { RolesGuard } from './roles.guard.js';

function createContext(
  user: AuthenticatedUser,
  requiredRoles: Role[] | undefined,
) {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(requiredRoles),
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
  return { guard: new RolesGuard(reflector as unknown as Reflector), context };
}

describe('RolesGuard', () => {
  const owner: AuthenticatedUser = {
    id: 'u1',
    email: 'o@example.com',
    displayName: 'Owner',
    role: Role.OWNER,
    projectId: null,
    sessionId: 's1',
  };

  it('allows any authenticated user when no @Roles() is declared', () => {
    const { guard, context } = createContext(owner, undefined);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows a user whose role is in the required list', () => {
    const { guard, context } = createContext(owner, [
      Role.OWNER,
      Role.ACCOUNTANT,
    ]);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects a user whose role is not in the required list', () => {
    const { guard, context } = createContext(owner, [Role.PROJECT_MANAGER]);
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    try {
      guard.canActivate(context);
    } catch (error) {
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'FORBIDDEN',
      });
    }
  });
});
