import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';

export class UpdateFloorDto {
  @ApiProperty({ example: 'Floor 3 (renamed)', required: false })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  label?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiProperty({
    required: false,
    description:
      'Archive (false) or restore (true) this floor. No hard delete.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
