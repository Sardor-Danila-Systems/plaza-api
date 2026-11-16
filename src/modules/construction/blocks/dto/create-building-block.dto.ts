import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class CreateBuildingBlockDto {
  @ApiProperty({ example: 'Block A' })
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiProperty({
    example: 'block-a',
    description: 'Stable per-project identifier. Immutable once created.',
  })
  @IsString()
  @Length(1, 100)
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message:
      'code must be lowercase kebab-case (letters, digits, single hyphens)',
  })
  code!: string;

  @ApiProperty({
    required: false,
    nullable: true,
    example: 'A',
    description: 'Construction stage (очередь). null clears it.',
  })
  @IsOptional()
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
