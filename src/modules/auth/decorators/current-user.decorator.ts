import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AuthenticatedUser } from '../types/authenticated-user.js';

/**
 * The only sanctioned way business code reads "who is making this request".
 * Requires `JwtAuthGuard` to have already run (it populates `req.user`) —
 * using this on a `@Public()` route is a programming error, not a runtime
 * fallback, so it intentionally does not guard against `req.user` being
 * undefined.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { user: AuthenticatedUser }>();
    return request.user;
  },
);
