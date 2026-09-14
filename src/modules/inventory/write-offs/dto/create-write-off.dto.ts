import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { IsBusinessDate } from '../../../../common/validators/is-business-date.validator.js';
import { IsDecimalString } from '../../../../common/validators/decimal-string.validator.js';

/**
 * A construction-consumption write-off (docs/backend-architecture.md §2:
 * "Require both building block and floor, and validate their
 * relationship"). No currency/rate fields at all — a write-off creates no
 * cash transaction (docs/backend-architecture.md §7); its cost is entirely
 * derived from the balance's own current weighted-average cost at write-off
 * time (transaction-design.md §6), never client-supplied.
 */
export class CreateWriteOffDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  materialId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  blockId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  floorId!: string;

  @ApiProperty({ example: '25.500000' })
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
