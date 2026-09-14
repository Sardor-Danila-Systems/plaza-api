import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Length, Min } from 'class-validator';

/**
 * `label` (not a bare integer) matches the approved data model — real
 * floors aren't always sequential numbers ("Ground", "Mezzanine",
 * "Basement 1"). `sortOrder` carries display ordering independently and may
 * repeat/be non-sequential; it is not a uniqueness key.
 */
export class CreateFloorDto {
  @ApiProperty({ example: 'Floor 3' })
  @IsString()
  @Length(1, 100)
  label!: string;

  @ApiProperty({ example: 3 })
  @IsInt()
  @Min(0)
  sortOrder!: number;
}
