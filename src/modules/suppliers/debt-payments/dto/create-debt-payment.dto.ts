import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { Currency } from '../../../../generated/prisma/client.js';
import { IsBusinessDate } from '../../../../common/validators/is-business-date.validator.js';
import { IsDecimalString } from '../../../../common/validators/decimal-string.validator.js';
import { IsValidCurrencyRateShape } from '../../../../common/validators/currency-rate-shape.validator.js';

/**
 * Pays down a purchase's debt (this phase's §6.5-6.8). `settlementExchangeRate`
 * is validated for FORMAT only here — whether it is required at all depends
 * on the target purchase's own currency (transaction-design.md §5's three
 * cases), which the DTO layer cannot know; the service rejects a
 * missing/extra one with `409 SETTLEMENT_RATE_REQUIRED` after resolving the
 * purchase.
 */
export class CreateDebtPaymentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  purchaseId!: string;

  @ApiProperty({
    enum: Currency,
    description: 'The currency of this specific payment.',
  })
  @IsEnum(Currency)
  @IsValidCurrencyRateShape()
  currency!: Currency;

  @ApiProperty({ example: '4000000.00' })
  @IsDecimalString({ maxDecimalPlaces: 2 })
  amount!: string;

  @ApiProperty({ required: false, example: '12500.00000000' })
  @IsOptional()
  @IsDecimalString({ maxDecimalPlaces: 8 })
  exchangeRate?: string;

  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  currencyRateId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  rateOverrideReason?: string;

  @ApiProperty({
    required: false,
    example: '12500.00000000',
    description:
      "Required only when this payment's currency differs from the purchase's currency AND the purchase's currency is not UZS (transaction-design.md §5 case 3). The UZS value of one unit of the purchase's currency, explicitly confirmed for this allocation.",
  })
  @IsOptional()
  @IsDecimalString({ maxDecimalPlaces: 8 })
  settlementExchangeRate?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(1, 1000)
  comment?: string;

  @ApiProperty({ example: '2026-09-14' })
  @IsBusinessDate()
  occurredAt!: string;
}
