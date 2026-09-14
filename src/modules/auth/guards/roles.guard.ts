import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ROLES_KEY } from '../decorators/roles.decorator.js';
import { AuthenticatedUser } from '../types/authenticated-user.js';

/**
 * Runs after `JwtAuthGuard` (which must populate `req.user`). A route with
 * no `@Roles(...)` decorator is allowed for any authenticated user — role
 * restriction is opt-in per route, same as `@Public()` is opt-out for
 * authentication. See docs/backend-architecture.md §13/§14: this proves
 * *role* membership only, never project ownership — that is
 * ProjectAccessService's job (src/modules/projects/), wired in from Phase 3.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<
      string[] | undefined
    >(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user: AuthenticatedUser }>();
    if (!requiredRoles.includes(request.user.role)) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'You do not have permission to perform this action',
      });
    }
    return true;
  }
}
