import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { Currency } from '../../../../generated/prisma/client.js';
import { IsBusinessDate } from '../../../../common/validators/is-business-date.validator.js';
import { IsDecimalString } from '../../../../common/validators/decimal-string.validator.js';

/**
 * Manual quote entry only in Phase 4 (`RateSource.PROVIDER` is reserved for
 * a future automatic-rate-provider integration, deliberately deferred —
 * docs/backend-architecture.md §2). `currency` only accepts `USD` — UZS is
 * always the implicit base and is never itself a quoted currency, matching
 * `CurrencyRate.currency`'s own doc comment and its
 * `CurrencyRate_currency_not_base_check` database constraint.
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
}
