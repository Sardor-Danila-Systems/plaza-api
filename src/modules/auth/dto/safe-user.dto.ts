import { ApiProperty } from '@nestjs/swagger';
import { Role } from '../../../generated/prisma/client.js';
import { AuthenticatedUser } from '../types/authenticated-user.js';

/**
 * The only shape a user is ever serialized as in an API response.
 * `passwordHash` has no field here at all — not "omitted at serialization
 * time" but structurally absent, so there is nothing to forget to strip.
 */
export class SafeUserDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty()
  displayName!: string;

  @ApiProperty({ enum: Role, enumName: 'Role' })
  role!: Role;

  @ApiProperty({ format: 'uuid', nullable: true })
  projectId!: string | null;

  static fromAuthenticatedUser(user: AuthenticatedUser): SafeUserDto {
    const dto = new SafeUserDto();
    dto.id = user.id;
    dto.email = user.email;
    dto.displayName = user.displayName;
    dto.role = user.role;
    dto.projectId = user.projectId;
    return dto;
  }
}
