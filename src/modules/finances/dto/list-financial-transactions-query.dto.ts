import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import {
  Currency,
  FinancialTransactionType,
} from '../../../generated/prisma/client.js';
import { IsBusinessDate } from '../../../common/validators/is-business-date.validator.js';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export class ListFinancialTransactionsQueryDto {
  @ApiPropertyOptional({
    example: '2026-09-01',
    description: 'Inclusive lower bound on occurredAt (business date).',
  })
  @IsOptional()
  @IsBusinessDate()
  dateFrom?: string;

  @ApiPropertyOptional({
    example: '2026-09-30',
    description:
      'Exclusive upper bound on occurredAt (business date) — matches ' +
      'docs/backend-architecture.md §11\'s "[from,to)" convention.',
  })
  @IsOptional()
  @IsBusinessDate()
  dateTo?: string;

  @ApiPropertyOptional({ enum: FinancialTransactionType })
  @IsOptional()
  @IsIn(Object.values(FinancialTransactionType))
  type?: FinancialTransactionType;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ enum: Currency })
  @IsOptional()
  @IsEnum(Currency)
  currency?: Currency;

  @ApiPropertyOptional({
    default: false,
    description: 'Include cancelled transactions (excluded by default).',
  })
  @IsOptional()
  // A plain `@Type(() => Boolean)` is a trap for query strings: `Boolean('false')`
  // is `true` (any non-empty string is truthy) — coerce explicitly instead.
  @Transform(({ value }) => value === 'true' || value === true)
  includeCancelled?: boolean;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    default: DEFAULT_PAGE_SIZE,
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize: number = DEFAULT_PAGE_SIZE;
}
