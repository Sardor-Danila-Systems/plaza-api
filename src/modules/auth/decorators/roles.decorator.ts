import { SetMetadata } from '@nestjs/common';
import { Role } from '../../../generated/prisma/client.js';

export const ROLES_KEY = 'roles';

/**
 * Declares which roles may access a route. NOTE: this alone is never
 * sufficient for a project-scoped resource — `@Roles(Role.PROJECT_MANAGER)`
 * only proves the caller manages *some* project, not the one in the route.
 * Every project-scoped write must also call `ProjectAccessService.assertAccess`
 * (see src/modules/projects/) — that is the Phase 3 wiring this decorator
 * exists to support, not a replacement for it.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
