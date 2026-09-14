import { ApiProperty } from '@nestjs/swagger';
import { Currency } from '../../../../generated/prisma/client.js';

export class CurrencyAmountDto {
  @ApiProperty({ enum: Currency })
  currency!: Currency;

  @ApiProperty({ example: '5000000.00' })
  amount!: string;
}

export class SupplierPurchaseSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: Currency })
  currency!: Currency;

  @ApiProperty({ example: '30000000.00' })
  totalAmount!: string;

  @ApiProperty({ example: '10000000.00' })
  remainingDebt!: string;

  @ApiProperty()
  cancelled!: boolean;

  @ApiProperty({ example: '2026-09-14' })
  occurredAt!: string;
}

export class SupplierLedgerResponseDto {
  @ApiProperty({ format: 'uuid' })
  supplierId!: string;

  @ApiProperty({
    type: [CurrencyAmountDto],
    description:
      'Outstanding debt across all non-cancelled purchases, by currency.',
  })
  outstandingDebt!: CurrencyAmountDto[];

  @ApiProperty({
    type: [CurrencyAmountDto],
    description: 'Available (unconsumed) advance balance, by currency.',
  })
  availableAdvance!: CurrencyAmountDto[];

  @ApiProperty({ type: [SupplierPurchaseSummaryDto] })
  purchases!: SupplierPurchaseSummaryDto[];
}
