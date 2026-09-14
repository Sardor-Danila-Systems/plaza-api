import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { IsBusinessDate } from '../../../../common/validators/is-business-date.validator.js';
import { IsDecimalString } from '../../../../common/validators/decimal-string.validator.js';

/**
 * A same-project warehouse-to-warehouse transfer (transaction-design.md
 * §7). No currency/rate fields — a transfer creates no cash transaction
 * (docs/backend-architecture.md §7); its cost is the exact value removed at
 * the source, never independently recomputed at the destination.
 */
export class CreateTransferDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  sourceWarehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  destinationWarehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  materialId!: string;

  @ApiProperty({ example: '50.000000' })
  @IsDecimalString({ maxDecimalPlaces: 6 })
  quantity!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(1, 1000)
  comment?: string;

  @ApiProperty({ example: '2026-09-14' })
  @IsBusinessDate()
  occurredAt!: string;
}
