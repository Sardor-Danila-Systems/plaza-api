import { ApiProperty } from '@nestjs/swagger';

export class TransferResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  projectId!: string;

  @ApiProperty({ format: 'uuid' })
  sourceWarehouseId!: string;

  @ApiProperty()
  sourceWarehouseNameSnapshot!: string;

  @ApiProperty({ format: 'uuid' })
  destinationWarehouseId!: string;

  @ApiProperty()
  destinationWarehouseNameSnapshot!: string;

  @ApiProperty({ format: 'uuid' })
  materialId!: string;

  @ApiProperty()
  materialNameSnapshot!: string;

  @ApiProperty({ example: '50.000000' })
  quantity!: string;

  @ApiProperty({ example: '76666.66666667' })
  unitCostUzs!: string;

  @ApiProperty({ example: '3833333.33333333' })
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
