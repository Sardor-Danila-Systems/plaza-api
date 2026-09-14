import { ApiProperty } from '@nestjs/swagger';

/**
 * Deliberately not `SafeUserDto` (which also carries `role`/`projectId` —
 * redundant/confusing on a project's own response, since the project IS the
 * `projectId` and the role is implicitly PROJECT_MANAGER). Explicit
 * select/mapping only — see Phase 3 §28: never a raw Prisma `User` row.
 */
export class ManagerSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  displayName!: string;

  @ApiProperty()
  email!: string;
}
