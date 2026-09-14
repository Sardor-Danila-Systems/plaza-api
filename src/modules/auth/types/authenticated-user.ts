import { Role } from '../../../generated/prisma/client.js';

/**
 * What `JwtAuthGuard` attaches to `req.user` after verifying the access
 * token AND re-loading the session/user from the database (see
 * docs/adr/0009-per-request-session-revalidation.md). This is the ONLY
 * source business code may use for the current actor's identity —
 * `createdById`/`actorId`/`userId` must never be accepted from a request
 * body (docs/backend-architecture.md §9 "actor identity must come from
 * trusted authentication context").
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  projectId: string | null;
  /** The RefreshSession.id backing the access token's `sid` claim. */
  sessionId: string;
}
