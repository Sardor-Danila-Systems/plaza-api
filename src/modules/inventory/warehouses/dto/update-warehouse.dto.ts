import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

/** `code` is deliberately absent — a stable identifier, never regenerated
 * once created, matching Project.code/BuildingBlock.code's own convention. */
export class UpdateWarehouseDto {
  @ApiProperty({ example: 'Main Warehouse (renamed)', required: false })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(1, 1000)
  comment?: string;

  @ApiProperty({
    required: false,
    description:
      'Archive (false) or restore (true) this warehouse. No hard delete.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
