import { ApiProperty } from '@nestjs/swagger';
import { Currency } from '../../../../generated/prisma/client.js';

export class SupplierAdvanceResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  projectId!: string;

  @ApiProperty({ format: 'uuid' })
  supplierId!: string;

  @ApiProperty({ format: 'uuid' })
  fundingPaymentId!: string;

  @ApiProperty({ enum: Currency })
  currency!: Currency;

  @ApiProperty({ example: '10000000.00' })
  fundedAmount!: string;

  @ApiProperty({ example: '10000000.00' })
  fundedAmountUzs!: string;

  @ApiProperty({
    example: '10000000.00',
    description:
      'fundedAmount minus the sum of effective settlement allocations consuming it.',
  })
  availableAmount!: string;

  @ApiProperty()
  createdAt!: Date;
}
