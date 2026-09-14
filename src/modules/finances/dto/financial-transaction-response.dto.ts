import { ApiProperty } from '@nestjs/swagger';
import {
  Currency,
  FinancialTransactionType,
  RateSource,
  TransactionDirection,
} from '../../../generated/prisma/client.js';

export class FinancialTransactionResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  projectId!: string;

  @ApiProperty({ format: 'uuid' })
  operationId!: string;

  @ApiProperty({ enum: FinancialTransactionType })
  type!: FinancialTransactionType;

  @ApiProperty({ enum: TransactionDirection })
  direction!: TransactionDirection;

  @ApiProperty({ example: '150000.00', description: 'Decimal string.' })
  amount!: string;

  @ApiProperty({ enum: Currency })
  currency!: Currency;

  @ApiProperty({
    example: '1',
    description: 'Decimal string. Always "1" for UZS.',
  })
  exchangeRate!: string;

  @ApiProperty({ example: '150000.00', description: 'Decimal string.' })
  amountUzs!: string;

  @ApiProperty({ enum: RateSource })
  rateSource!: RateSource;

  @ApiProperty({ required: false, format: 'uuid', nullable: true })
  rateId!: string | null;

  @ApiProperty({ required: false, nullable: true })
  rateOverrideReason!: string | null;

  @ApiProperty({ required: false, format: 'uuid', nullable: true })
  categoryId!: string | null;

  @ApiProperty({ required: false, nullable: true })
  categoryNameSnapshot!: string | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'The "source" field for INCOME, "recipient" for EXPENSE/SALARY.',
  })
  recipient!: string | null;

  @ApiProperty({ required: false, nullable: true })
  comment!: string | null;

  @ApiProperty({
    example: '2026-09-14',
    description: 'Business date (YYYY-MM-DD).',
  })
  occurredAt!: string;

  @ApiProperty({ format: 'uuid' })
  createdById!: string;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;

  @ApiProperty({ nullable: true })
  cancelledAt!: Date | null;

  @ApiProperty({ nullable: true })
  cancellationReason!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true })
  cancelledById!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true })
  reversalOfId!: string | null;
}
