import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { IsDecimalString } from '../../../../common/validators/decimal-string.validator.js';

export class CreateMaterialDto {
  @ApiProperty({ example: 'Portland Cement M500' })
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiProperty({
    example: 'cement-m500',
    description: 'Stable per-project identifier. Immutable once created.',
  })
  @IsString()
  @Length(1, 100)
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message:
      'code must be lowercase kebab-case (letters, digits, single hyphens)',
  })
  code!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  categoryId!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Immutable once created (docs/backend-data-model.md).',
  })
  @IsUUID()
  unitId!: string;

  @ApiProperty({
    required: false,
    example: '100.000000',
    description:
      'Positive decimal string, at most 6 fractional digits. Omit to disable the low-stock warning.',
  })
  @IsOptional()
  @IsDecimalString({ maxDecimalPlaces: 6, positive: false })
  minimumStock?: string;
}
