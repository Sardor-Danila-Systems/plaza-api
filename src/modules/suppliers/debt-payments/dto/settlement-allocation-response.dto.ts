import { ApiProperty } from '@nestjs/swagger';
import {
  Currency,
  SettlementEffect,
} from '../../../../generated/prisma/client.js';

export class SettlementAllocationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  purchaseId!: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  fundingPaymentId!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true })
  advanceId!: string | null;

  @ApiProperty({ enum: Currency })
  settlementCurrency!: Currency;

  @ApiProperty({ example: '4000000.00' })
  settlementAmount!: string;

  @ApiProperty({ example: '4000000.00' })
  settlementValueUzs!: string;

  @ApiProperty({ enum: Currency })
  debtCurrency!: Currency;

  @ApiProperty({ nullable: true, example: '12500.00000000' })
  settlementExchangeRate!: string | null;

  @ApiProperty({ example: '4000000.00' })
  debtAmountSettled!: string;

  @ApiProperty({ example: '0.00' })
  exchangeDifferenceUzs!: string;

  @ApiProperty({ enum: SettlementEffect })
  effect!: SettlementEffect;

  @ApiProperty()
  createdAt!: Date;
}
