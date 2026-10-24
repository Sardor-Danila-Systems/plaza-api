import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class CreateUnitDto {
  @ApiProperty({ example: 'Kilogram' })
  @IsString()
  @Length(1, 100)
  name!: string;

  @ApiProperty({ example: 'кг' })
  @IsString()
  @Length(1, 20)
  symbol!: string;
}
