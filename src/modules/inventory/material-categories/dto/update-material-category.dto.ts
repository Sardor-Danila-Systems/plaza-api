import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

export class UpdateMaterialCategoryDto {
  @ApiPropertyOptional({ example: 'Cement & Binders' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiPropertyOptional({ description: 'Archive (false) or restore (true).' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
