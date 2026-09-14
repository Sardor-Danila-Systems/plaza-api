import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { AppConfigService } from '../../../config/app-config.service.js';
import { CSRF_HEADER, CSRF_TOKEN_COOKIE } from '../auth.constants.js';

/**
 * Defense-in-depth for the two cookie-authenticated mutating endpoints
 * (`POST /auth/refresh`, `POST /auth/logout`) per
 * docs/backend-architecture.md §9: "Validate Origin and CSRF token on
 * cookie-authenticated refresh/logout, configure exact CORS origins."
 *
 * Double-submit cookie pattern: login sets a non-HttpOnly `csrf_token`
 * cookie; the client must echo its value in the `X-CSRF-Token` header. A
 * cross-origin attacker's browser will send the ambient refresh cookie
 * automatically but cannot read its value to also set the matching header
 * (same-origin policy), so a mismatched/missing header blocks the forgery
 * without requiring server-side session storage of the CSRF token itself.
 *
 * Origin check: only enforced once a real frontend origin is configured
 * (`CORS_ORIGIN` non-empty) — with no configured origin yet (this repo's
 * current default), there is nothing meaningful to compare against.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    const allowedOrigins = this.config.corsOrigins;
    const origin = request.headers.origin;
    if (
      allowedOrigins.length > 0 &&
      origin &&
      !allowedOrigins.includes(origin)
    ) {
      throw new ForbiddenException({
        code: 'CSRF_TOKEN_MISMATCH',
        message: 'Request origin is not allowed',
      });
    }

    const cookieToken = request.cookies?.[CSRF_TOKEN_COOKIE];
    const headerToken = request.headers[CSRF_HEADER];

    if (
      !cookieToken ||
      !headerToken ||
      Array.isArray(headerToken) ||
      headerToken !== cookieToken
    ) {
      throw new ForbiddenException({
        code: 'CSRF_TOKEN_MISMATCH',
        message: 'Missing or invalid CSRF token',
      });
    }

    return true;
  }
}
