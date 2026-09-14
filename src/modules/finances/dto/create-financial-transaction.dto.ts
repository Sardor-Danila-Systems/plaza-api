import { ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import {
  Currency,
  FinancialTransactionType,
} from '../../../generated/prisma/client.js';
import { IsBusinessDate } from '../../../common/validators/is-business-date.validator.js';
import { IsDecimalString } from '../../../common/validators/decimal-string.validator.js';
import { IsValidFinancialTransactionShape } from './financial-transaction-shape.validator.js';

/** The Phase 4 subset of `FinancialTransactionType` this endpoint accepts.
 * `PURCHASE`/`ADVANCE`/`DEBT_PAYMENT`/`REFUND`/`ADJUSTMENT` are declared on
 * the enum for later phases' workflows but have no posting path yet. */
const CREATABLE_TYPES = [
  FinancialTransactionType.INCOME,
  FinancialTransactionType.EXPENSE,
  FinancialTransactionType.SALARY,
] as const;

export class CreateFinancialTransactionDto {
  @ApiProperty({
    enum: CREATABLE_TYPES,
    description: 'Only INCOME, EXPENSE, and SALARY are postable in Phase 4.',
  })
  @IsIn(CREATABLE_TYPES)
  @IsValidFinancialTransactionShape()
  type!: FinancialTransactionType;

  @ApiProperty({
    example: '150000.00',
    description: 'Positive decimal string, at most 2 fractional digits.',
  })
  @IsDecimalString({ maxDecimalPlaces: 2 })
  amount!: string;

  @ApiProperty({ enum: Currency })
  @IsEnum(Currency)
  currency!: Currency;

  @ApiProperty({
    required: false,
    example: '12500.00000000',
    description:
      'Required (with rateOverrideReason) for a USD transaction NOT referencing an existing currencyRateId. Must not be supplied for UZS.',
  })
  @IsOptional()
  @IsDecimalString({ maxDecimalPlaces: 8 })
  exchangeRate?: string;

  @ApiProperty({
    required: false,
    format: 'uuid',
    description:
      'References an existing CurrencyRate row to use its recorded rate. Mutually exclusive with exchangeRate/rateOverrideReason. Must not be supplied for UZS.',
  })
  @IsOptional()
  @IsUUID()
  currencyRateId?: string;

  @ApiProperty({
    required: false,
    example: 'Negotiated rate for this specific payment',
    description:
      'Required whenever exchangeRate is supplied directly rather than via currencyRateId.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  rateOverrideReason?: string;

  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiProperty({
    required: false,
    description: 'Who/what the money came from. INCOME only.',
    example: 'Owner capital contribution',
  })
  @IsOptional()
  @IsString()
  @Length(1, 300)
  source?: string;

  @ApiProperty({
    required: false,
    description: 'Who received the payment. EXPENSE/SALARY only.',
    example: 'ACME Building Supplies',
  })
  @IsOptional()
  @IsString()
  @Length(1, 300)
  recipient?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(1, 1000)
  comment?: string;

  @ApiProperty({
    example: '2026-09-14',
    description:
      'Business date (YYYY-MM-DD), interpreted in the project timezone. Cannot be in the future.',
  })
  @IsBusinessDate()
  occurredAt!: string;
}
