import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Opts a route out of the global `JwtAuthGuard` (see auth.module.ts). Applied
 * to POST /auth/login and POST /auth/refresh, and to GET /health (Phase 1).
 * Deliberately opt-out rather than opt-in: a new route with no decorator at
 * all defaults to requiring authentication, not the other way around.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
