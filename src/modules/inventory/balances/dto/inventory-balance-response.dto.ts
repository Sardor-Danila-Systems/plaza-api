import { ApiProperty } from '@nestjs/swagger';

export class InventoryBalanceResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  projectId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty()
  warehouseName!: string;

  @ApiProperty({ format: 'uuid' })
  materialId!: string;

  @ApiProperty()
  materialName!: string;

  @ApiProperty({ format: 'uuid' })
  unitId!: string;

  @ApiProperty()
  unitSymbol!: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  categoryId!: string | null;

  @ApiProperty({ example: '80.500000', description: 'Decimal string.' })
  quantity!: string;

  @ApiProperty({
    example: '50000.00000000',
    description:
      'Derived: valueUzs / quantity, exactly "0" when quantity is 0.',
  })
  averageCostUzs!: string;

  @ApiProperty({ example: '4025000.00000000', description: 'Decimal string.' })
  valueUzs!: string;

  @ApiProperty({ nullable: true, example: '100.000000' })
  minimumStock!: string | null;

  @ApiProperty({
    description: 'true iff minimumStock is set and quantity < minimumStock.',
  })
  lowStock!: boolean;

  @ApiProperty()
  updatedAt!: Date;
}
