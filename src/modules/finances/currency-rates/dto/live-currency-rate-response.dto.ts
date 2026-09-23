import { ApiProperty } from '@nestjs/swagger';
import { RateSource } from '../../../../generated/prisma/client.js';

export class LiveCurrencyRateResponseDto {
  @ApiProperty({ example: '12500.00', description: 'Decimal string, official CBU rate.' })
  rateUzs!: string;

  @ApiProperty({ example: '2026-09-23' })
  asOf!: string;

  @ApiProperty({ enum: [RateSource.PROVIDER] })
  source!: RateSource;

  @ApiProperty({ description: 'True if this is a cached value served after a failed refetch.' })
  stale!: boolean;
}
