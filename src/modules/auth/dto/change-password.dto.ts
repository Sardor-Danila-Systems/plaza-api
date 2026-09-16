import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @ApiProperty({ writeOnly: true })
  @IsString()
  @MinLength(1)
  currentPassword!: string;

  @ApiProperty({ writeOnly: true, minLength: 8 })
  @IsString()
  @MinLength(8)
  newPassword!: string;
}
