import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { BuildingBlockResponseDto } from './building-block-response.dto.js';

/**
 * One block of a bulk create, optionally with all of its floors. Floors are
 * given as explicit labels rather than a count so the server never has to
 * invent display text in a particular language — the caller names them
 * ("Этаж 1" … "Этаж 9", "Подвал", "Кровля") and their order becomes
 * `sortOrder`.
 */
export class BulkBuildingBlockDto {
  @ApiProperty({ example: 'Блок А' })
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiProperty({
    example: 'blok-a',
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
    type: [String],
    example: ['Этаж 1', 'Этаж 2', 'Этаж 3'],
    description:
      'Floor labels in display order — index becomes sortOrder. Omit for a block with no floors yet.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @Length(1, 100, { each: true })
  floorLabels?: string[];
}

/**
 * Creating a tower one block and one floor at a time meant dozens of round
 * trips to describe a building whose shape ("4 blocks, 9 floors each") is
 * known up front. This posts the whole shape at once, in a single
 * transaction — either the entire set appears or none of it does.
 */
export class CreateBuildingBlocksBulkDto {
  @ApiProperty({ type: [BulkBuildingBlockDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BulkBuildingBlockDto)
  blocks!: BulkBuildingBlockDto[];
}

export class BulkBuildingBlocksResponseDto {
  @ApiProperty({ type: [BuildingBlockResponseDto] })
  blocks!: BuildingBlockResponseDto[];

  @ApiProperty({ example: 27 })
  floorsCreated!: number;
}
