import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { Currency } from '../../../../generated/prisma/client.js';
import { IsBusinessDate } from '../../../../common/validators/is-business-date.validator.js';
import { IsDecimalString } from '../../../../common/validators/decimal-string.validator.js';
import { IsValidCurrencyRateShape } from '../../../../common/validators/currency-rate-shape.validator.js';

/**
 * Money paid to a supplier for future purchases (this phase's §6.3) —
 * always a cash OUTFLOW. Posted atomically as one `SupplierPayment`
 * (`purpose = ADVANCE_FUNDING`), one `SupplierAdvance`, one
 * `FinancialTransaction` (`type = ADVANCE`, `direction = OUT`), and one
 * audit row, inside the project lock.
 */
export class CreateSupplierAdvanceDto {
  @ApiProperty({ enum: Currency })
  @IsEnum(Currency)
  @IsValidCurrencyRateShape()
  currency!: Currency;

  @ApiProperty({ example: '10000000.00' })
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

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(1, 1000)
  comment?: string;

  @ApiProperty({ example: '2026-09-14' })
  @IsBusinessDate()
  occurredAt!: string;
}
