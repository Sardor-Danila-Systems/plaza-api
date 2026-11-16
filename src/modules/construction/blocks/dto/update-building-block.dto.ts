import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

/** `code` is deliberately absent — a stable identifier, never regenerated
 * once created (Phase 3 §19), matching Project.code's own convention. */
export class UpdateBuildingBlockDto {
  @ApiProperty({ example: 'Block A (renamed)', required: false })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiProperty({
    required: false,
    description:
      'Archive (false) or restore (true) this block. No hard delete.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({
    required: false,
    nullable: true,
    example: 'A',
    description: 'Construction stage (очередь). null clears it.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(1, 50)
  stage?: string | null;

  @ApiProperty({
    required: false,
    example: 1,
    description: 'Build/display order within the project.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  sortOrder?: number;
}
