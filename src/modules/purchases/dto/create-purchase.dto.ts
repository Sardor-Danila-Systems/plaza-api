import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
} from 'class-validator';
import { Currency } from '../../../generated/prisma/client.js';
import { IsBusinessDate } from '../../../common/validators/is-business-date.validator.js';
import { IsDecimalString } from '../../../common/validators/decimal-string.validator.js';
import { IsValidCurrencyRateShape } from '../../../common/validators/currency-rate-shape.validator.js';
import { AdvanceAllocationInputDto } from './advance-allocation-input.dto.js';
import { PurchaseItemInputDto } from './purchase-item-input.dto.js';

/**
 * One posted invoice + simultaneous material receipt
 * (docs/backend-architecture.md §2). Never accepts a client-supplied total,
 * debt, status, or UZS cost — all server-computed
 * (transaction-design.md §4). `cashPaid` is always in the purchase's own
 * `currency` (Phase 7's own scope decision — a cross-currency cash payment
 * within purchase creation is not supported; use a separate debt payment
 * afterward for that). `advanceAllocations` may use a different currency
 * per advance, using the same cross-currency formula as debt payments.
 */
export class CreatePurchaseDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  supplierId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ enum: Currency })
  @IsEnum(Currency)
  @IsValidCurrencyRateShape()
  currency!: Currency;

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

  @ApiProperty({ type: [PurchaseItemInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseItemInputDto)
  items!: PurchaseItemInputDto[];

  @ApiProperty({ required: false, type: [AdvanceAllocationInputDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdvanceAllocationInputDto)
  advanceAllocations?: AdvanceAllocationInputDto[];

  @ApiProperty({
    required: false,
    example: '20000000.00',
    description:
      "Cash paid now, in the purchase's own currency. Omit or 0 for a fully credit/advance-funded purchase.",
  })
  @IsOptional()
  @IsDecimalString({ maxDecimalPlaces: 2, positive: false })
  cashPaid?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  invoiceNumber?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(1, 1000)
  comment?: string;

  @ApiProperty({ example: '2026-09-14' })
  @IsBusinessDate()
  occurredAt!: string;
}
