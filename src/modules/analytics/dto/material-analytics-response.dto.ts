import { ApiProperty } from '@nestjs/swagger';

export class MaterialAnalyticsRowDto {
  @ApiProperty({ format: 'uuid' })
  materialId!: string;

  @ApiProperty()
  materialName!: string;

  @ApiProperty({
    description:
      'Sum of PurchaseItem.quantity for purchases with occurredAt in [from, to).',
  })
  purchasedQuantity!: string;

  @ApiProperty({
    description:
      'Sum of PurchaseItem.lineAmountUzs for purchases with occurredAt in [from, to).',
  })
  purchasedValueUzs!: string;

  @ApiProperty({
    description:
      'Net write-off consumption in [from, to) — original write-off costs less their own reversals (never transfers or purchase receipts).',
  })
  consumedQuantity!: string;

  @ApiProperty()
  consumedValueUzs!: string;
}

export class MaterialsAnalyticsResponseDto {
  @ApiProperty({ format: 'uuid' })
  projectId!: string;

  @ApiProperty({ nullable: true })
  dateFrom!: string | null;

  @ApiProperty({ nullable: true })
  dateTo!: string | null;

  @ApiProperty({ type: [MaterialAnalyticsRowDto] })
  materials!: MaterialAnalyticsRowDto[];
}
