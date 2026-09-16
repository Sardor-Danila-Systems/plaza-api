import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/**
 * The ONLY self-service profile update. Deliberately does not accept
 * email/role/projectId/isActive — see SafeUserDto's own doc comment and
 * this endpoint's controller comment for why each of those is excluded.
 */
export class UpdateMeDto {
  @ApiProperty({ example: 'Aziz Karimov' })
  @IsString()
  @Length(1, 200)
  displayName!: string;
}
