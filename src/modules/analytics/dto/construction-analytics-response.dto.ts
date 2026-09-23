import { ApiProperty } from '@nestjs/swagger';

export class ConstructionAnalyticsRowDto {
  @ApiProperty({ format: 'uuid' })
  blockId!: string;

  @ApiProperty()
  blockName!: string;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description: 'null for material written off against the whole block.',
  })
  floorId!: string | null;

  @ApiProperty({ nullable: true })
  floorLabel!: string | null;

  @ApiProperty({ format: 'uuid' })
  materialId!: string;

  @ApiProperty()
  materialName!: string;

  @ApiProperty({
    description:
      'Sum of still-effective (non-cancelled) StockWriteOff.quantity in [from, to).',
  })
  quantity!: string;

  @ApiProperty()
  valueUzs!: string;
}

export class ConstructionAnalyticsResponseDto {
  @ApiProperty({ format: 'uuid' })
  projectId!: string;

  @ApiProperty({ nullable: true })
  dateFrom!: string | null;

  @ApiProperty({ nullable: true })
  dateTo!: string | null;

  @ApiProperty({ type: [ConstructionAnalyticsRowDto] })
  rows!: ConstructionAnalyticsRowDto[];
}
