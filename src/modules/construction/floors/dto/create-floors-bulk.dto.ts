import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';

/**
 * Adding the floors of an existing block one dialog at a time was the
 * slowest part of describing a building. Labels arrive in display order and
 * their position sets `sortOrder`, continuing after whatever the block
 * already has unless `startSortOrder` says otherwise.
 */
export class CreateFloorsBulkDto {
  @ApiProperty({ type: [String], example: ['Этаж 1', 'Этаж 2', 'Этаж 3'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @Length(1, 100, { each: true })
  labels!: string[];

  @ApiProperty({
    required: false,
    description:
      'sortOrder of the first label. Defaults to continuing after the block’s current highest.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  startSortOrder?: number;
}
