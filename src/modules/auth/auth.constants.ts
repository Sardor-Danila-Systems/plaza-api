/**
 * Refresh and CSRF cookies are scoped to this path only (not "/"), per
 * docs/backend-architecture.md §9's "narrow auth path in production" —
 * neither cookie is ever sent on ordinary business API requests.
 */
export const AUTH_COOKIE_PATH = '/auth';
export const REFRESH_TOKEN_COOKIE = 'refresh_token';
/** Deliberately NOT HttpOnly — the client must be able to read it to echo it
 * back in the CSRF header (double-submit pattern, see csrf.guard.ts). */
export const CSRF_TOKEN_COOKIE = 'csrf_token';
export const CSRF_HEADER = 'x-csrf-token';
