import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { IsDecimalString } from '../../../../common/validators/decimal-string.validator.js';

/** `code` and `unitId` are deliberately absent — see `Material`'s doc
 * comment in schema.prisma: both are treated as fixed at creation,
 * anticipating docs/backend-data-model.md's "unit/project immutable after
 * first movement" rule. `categoryId` carries no such restriction. */
export class UpdateMaterialDto {
  @ApiPropertyOptional({ example: 'Portland Cement M500 (updated)' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    example: '150.000000',
    description: 'Set to null to disable the low-stock warning.',
    nullable: true,
  })
  @IsOptional()
  @IsDecimalString({ maxDecimalPlaces: 6, positive: false })
  minimumStock?: string | null;

  @ApiPropertyOptional({ description: 'Archive (false) or restore (true).' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
