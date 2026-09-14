import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches } from 'class-validator';

export class CreateWarehouseDto {
  @ApiProperty({ example: 'Main Warehouse' })
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiProperty({
    example: 'main',
    description: 'Stable per-project identifier. Immutable once created.',
  })
  @IsString()
  @Length(1, 100)
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message:
      'code must be lowercase kebab-case (letters, digits, single hyphens)',
  })
  code!: string;

  @ApiProperty({ required: false, example: 'Ground floor, Block A' })
  @IsOptional()
  @IsString()
  @Length(1, 1000)
  comment?: string;
}
