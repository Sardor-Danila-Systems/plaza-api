import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { IsDecimalString } from '../../../common/validators/decimal-string.validator.js';

export class AdvanceAllocationInputDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  advanceId!: string;

  @ApiProperty({
    example: '10000000.00',
    description: "Amount to consume, in the advance's own currency.",
  })
  @IsDecimalString({ maxDecimalPlaces: 2 })
  amount!: string;

  @ApiProperty({
    required: false,
    example: '12500.00000000',
    description:
      'Required only when the advance currency differs from the purchase currency AND the purchase currency is not UZS (transaction-design.md §5 case 3).',
  })
  @IsOptional()
  @IsDecimalString({ maxDecimalPlaces: 8 })
  settlementExchangeRate?: string;
}
