import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * Minimal in-process rate limiter for the two brute-force-target endpoints
 * (`POST /auth/login`, `POST /auth/refresh`) per
 * docs/backend-architecture.md §9's "rate-limit login and refresh".
 *
 * Deliberately hand-rolled instead of `@nestjs/throttler`: at the time this
 * was written, `@nestjs/throttler`'s latest release (6.5.0) only declares
 * peer support up to `@nestjs/common@^11`, not this project's `^12` — see
 * the Phase 2 report for the version check. A ~40-line fixed-window counter
 * is simple enough that pulling in a dependency with an unresolved peer
 * conflict isn't worth it.
 *
 * IMPORTANT — single-instance only: state is an in-memory `Map`, per Node
 * process. This is explicitly acceptable for development and a
 * single-instance deployment (per the Phase 2 specification's own
 * allowance) but is NOT distributed rate limiting — running multiple
 * instances behind a load balancer means each instance enforces its own
 * independent limit. Replacing the counter storage with Redis (keeping this
 * same guard interface) is the documented upgrade path if/when this
 * deploys behind more than one instance.
 */
export class AuthRateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const key = `${request.ip}:${request.method}:${request.path}`;
    const now = Date.now();

    this.evictExpired(now);

    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    if (entry.count >= this.limit) {
      throw new HttpException(
        {
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many attempts; please try again later',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    entry.count += 1;
    return true;
  }

  /** Lazily bounds the map's size instead of running a background timer —
   * proportionate to Phase 2's scope; see the class doc for the real fix. */
  private evictExpired(now: number): void {
    if (this.hits.size < 10_000) return;
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
  }
}
