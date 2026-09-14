import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

/**
 * `kind` is deliberately not editable: it is a load-bearing classification
 * (docs/transaction-design.md posting rules match a transaction's type
 * against its category's kind) — changing it on an in-use category would
 * silently reclassify historical rows' `categoryNameSnapshot` context.
 * Archive and recreate under the correct kind instead.
 */
export class UpdateTransactionCategoryDto {
  @ApiPropertyOptional({ example: 'Materials & Supplies' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiPropertyOptional({ description: 'Archive (false) or restore (true).' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
