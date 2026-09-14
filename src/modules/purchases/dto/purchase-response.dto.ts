import { ApiProperty } from '@nestjs/swagger';
import { Currency, RateSource } from '../../../generated/prisma/client.js';
import { PurchaseItemResponseDto } from './purchase-item-response.dto.js';

/** Derived, never persisted (this phase's §7.8 — "status must be derived
 * from accounting state"): CANCELLED if cancelledAt is set; otherwise PAID
 * (remaining debt is exactly 0), PARTIALLY_PAID (some but not all settled),
 * or UNPAID (nothing settled yet). */
export enum PurchaseStatus {
  UNPAID = 'UNPAID',
  PARTIALLY_PAID = 'PARTIALLY_PAID',
  PAID = 'PAID',
  CANCELLED = 'CANCELLED',
}

export class PurchaseResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  projectId!: string;

  @ApiProperty({ format: 'uuid' })
  supplierId!: string;

  @ApiProperty()
  supplierNameSnapshot!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty()
  warehouseNameSnapshot!: string;

  @ApiProperty({ enum: Currency })
  currency!: Currency;

  @ApiProperty({ example: '12500.00000000' })
  exchangeRate!: string;

  @ApiProperty({ enum: RateSource })
  rateSource!: RateSource;

  @ApiProperty({ format: 'uuid', nullable: true })
  rateId!: string | null;

  @ApiProperty({ nullable: true })
  rateOverrideReason!: string | null;

  @ApiProperty({ example: '30000000.00' })
  totalAmount!: string;

  @ApiProperty({ example: '30000000.00' })
  totalAmountUzs!: string;

  @ApiProperty({ example: '10000000.00' })
  remainingDebt!: string;

  @ApiProperty({ enum: PurchaseStatus })
  status!: PurchaseStatus;

  @ApiProperty({ nullable: true })
  invoiceNumber!: string | null;

  @ApiProperty({ nullable: true })
  comment!: string | null;

  @ApiProperty({ example: '2026-09-14' })
  occurredAt!: string;

  @ApiProperty({ format: 'uuid' })
  createdById!: string;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({ nullable: true })
  cancelledAt!: Date | null;

  @ApiProperty({ nullable: true })
  cancellationReason!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true })
  cancelledById!: string | null;

  @ApiProperty({ type: [PurchaseItemResponseDto] })
  items!: PurchaseItemResponseDto[];
}
