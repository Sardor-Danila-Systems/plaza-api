import { ApiProperty } from '@nestjs/swagger';
import { Currency, RateSource } from '../../../../generated/prisma/client.js';

export class CurrencyRateResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  projectId!: string;

  @ApiProperty({ enum: Currency })
  currency!: Currency;

  @ApiProperty({ example: '12500.00000000', description: 'Decimal string.' })
  rateUzs!: string;

  @ApiProperty({ example: '2026-09-14' })
  effectiveOn!: string;

  @ApiProperty({ enum: RateSource })
  source!: RateSource;

  @ApiProperty({ format: 'uuid' })
  createdById!: string;

  @ApiProperty()
  createdAt!: Date;
}
