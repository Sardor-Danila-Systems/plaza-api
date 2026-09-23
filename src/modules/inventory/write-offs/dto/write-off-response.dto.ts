import { ApiProperty } from '@nestjs/swagger';

export class WriteOffResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  projectId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty()
  warehouseNameSnapshot!: string;

  @ApiProperty({ format: 'uuid' })
  materialId!: string;

  @ApiProperty()
  materialNameSnapshot!: string;

  @ApiProperty({ format: 'uuid' })
  blockId!: string;

  @ApiProperty()
  blockNameSnapshot!: string;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description: 'null when the write-off targets the whole block.',
  })
  floorId!: string | null;

  @ApiProperty({ nullable: true })
  floorLabelSnapshot!: string | null;

  @ApiProperty({ example: '25.500000' })
  quantity!: string;

  @ApiProperty({ example: '76666.66666667' })
  unitCostUzs!: string;

  @ApiProperty({ example: '1955000.00000000' })
  totalCostUzs!: string;

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
}
