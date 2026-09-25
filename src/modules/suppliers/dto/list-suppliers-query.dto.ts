import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

/** Same shape as Phase 5's `ListMaterialsQueryDto` — the suppliers list is
 * the one master-data list that grows fastest in practice, and scrolling it
 * was the only way to find anything. */
export class ListSuppliersQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description:
      'Case-insensitive substring search over name, contact person, phone and taxpayer id.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  search?: string;
}
