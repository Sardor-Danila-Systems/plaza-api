import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Role } from '../../../generated/prisma/client.js';

/**
 * Only ever instantiated by `ProjectProvisioningService.createUser` — never
 * bound to an HTTP route (there is no user-creation endpoint, ADR 0014).
 * Validated with class-validator's standalone `validateSync`, the same
 * pattern `src/config/env.validation.ts` already uses outside a Nest
 * request pipeline (a `ValidationPipe` only runs for controller params).
 */
export class CreateUserDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  displayName!: string;

  @IsEnum(Role)
  role!: Role;

  /** Required iff role is PROJECT_MANAGER, rejected otherwise — enforced
   * in the service, not here, so the message can name the offending role. */
  @IsOptional()
  @IsUUID()
  projectId?: string;

  /** No existing password-strength precedent elsewhere in this codebase
   * (LoginDto only checks non-empty, since it's login, not creation) — a
   * plain minimum length is the smallest reasonable baseline for a new
   * production operator account. */
  @IsString()
  @MinLength(12, { message: 'password must be at least 12 characters' })
  @MaxLength(200)
  password!: string;
}
