import { ApiProperty } from '@nestjs/swagger';

export class PurchaseItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  lineNumber!: number;

  @ApiProperty({ format: 'uuid' })
  materialId!: string;

  @ApiProperty()
  materialNameSnapshot!: string;

  @ApiProperty({ example: '200.000000' })
  quantity!: string;

  @ApiProperty({ example: '75000.00000000' })
  unitPrice!: string;

  @ApiProperty({ example: '15000000.00' })
  lineAmount!: string;

  @ApiProperty({ example: '15000000.00' })
  lineAmountUzs!: string;
}
