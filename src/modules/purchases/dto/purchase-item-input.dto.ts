import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { IsDecimalString } from '../../../common/validators/decimal-string.validator.js';

export class PurchaseItemInputDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  materialId!: string;

  @ApiProperty({ example: '200.000000' })
  @IsDecimalString({ maxDecimalPlaces: 6 })
  quantity!: string;

  @ApiProperty({ example: '75000.00000000' })
  @IsDecimalString({ maxDecimalPlaces: 8 })
  unitPrice!: string;
}
