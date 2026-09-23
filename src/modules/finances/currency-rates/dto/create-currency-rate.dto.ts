import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { Currency, RateSource } from '../../../../generated/prisma/client.js';
import { IsBusinessDate } from '../../../../common/validators/is-business-date.validator.js';
import { IsDecimalString } from '../../../../common/validators/decimal-string.validator.js';

/**
 * `currency` only accepts `USD` — UZS is always the implicit base and is
 * never itself a quoted currency, matching `CurrencyRate.currency`'s own
 * doc comment and its `CurrencyRate_currency_not_base_check` database
 * constraint.
 *
 * `source` defaults to `MANUAL`. `PROVIDER` is used when the frontend saves
 * a quote it pulled from the live CBU rate endpoint (`GET
 * .../currency-rates/live`) — the value itself is still whatever the client
 * sends, this only labels its origin for the audit trail.
 */
export class CreateCurrencyRateDto {
  @ApiProperty({ enum: [Currency.USD] })
  @IsIn([Currency.USD])
  currency!: Currency;

  @ApiProperty({ example: '12500.00000000' })
  @IsDecimalString({ maxDecimalPlaces: 8 })
  rateUzs!: string;

  @ApiProperty({ example: '2026-09-14' })
  @IsBusinessDate()
  effectiveOn!: string;

  @ApiPropertyOptional({ enum: RateSource, default: RateSource.MANUAL })
  @IsOptional()
  @IsIn([RateSource.MANUAL, RateSource.PROVIDER])
  source?: RateSource;
}
