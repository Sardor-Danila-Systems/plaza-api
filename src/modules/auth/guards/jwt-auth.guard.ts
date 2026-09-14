import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PrismaService } from '../../../database/prisma.service.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { AuthenticatedUser } from '../types/authenticated-user.js';
import { TokenService } from '../token.service.js';

/**
 * Global guard (registered via APP_GUARD in auth.module.ts): every route
 * requires a valid access token UNLESS marked `@Public()`. Verifying the JWT
 * is only the first half — per docs/adr/0009-per-request-session-revalidation.md
 * this also re-loads the session and user from the database on every single
 * request, so a revoked session or a deactivated user is rejected
 * immediately, not only once the (short-lived) JWT itself expires.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokenService: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user: AuthenticatedUser }>();
    const token = this.extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Missing access token',
      });
    }

    const payload = await this.verifyToken(token);

    const session = await this.prisma.client.refreshSession.findUnique({
      where: { id: payload.sid },
      include: { user: true },
    });

    if (
      !session ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= Date.now() ||
      session.user.id !== payload.sub
    ) {
      // Same generic code whether the session was revoked, expired, or never
      // existed — distinguishing them would only help an attacker probe
      // which session IDs are real.
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Session is no longer valid',
      });
    }

    if (!session.user.isActive) {
      throw new ForbiddenException({
        code: 'USER_DISABLED',
        message: 'This account is disabled',
      });
    }

    request.user = {
      id: session.user.id,
      email: session.user.email,
      displayName: session.user.displayName,
      role: session.user.role,
      projectId: session.user.projectId,
      sessionId: session.id,
    };

    return true;
  }

  private extractBearerToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return null;
    }
    return header.slice('Bearer '.length).trim() || null;
  }

  private async verifyToken(token: string) {
    try {
      return await this.tokenService.verifyAccessToken(token);
    } catch (error) {
      // jsonwebtoken's own error classes are never allowed past this point —
      // AllExceptionsFilter must never see (and therefore never risk
      // partially leaking) a raw library error here.
      if (error instanceof Error && error.name === 'TokenExpiredError') {
        throw new UnauthorizedException({
          code: 'TOKEN_EXPIRED',
          message: 'Access token expired',
        });
      }
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Invalid access token',
      });
    }
  }
}
