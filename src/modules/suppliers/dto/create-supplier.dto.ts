import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';

export class CreateSupplierDto {
  @ApiProperty({ example: 'ACME Building Supplies' })
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  contactPerson?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(1, 50)
  phone?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(1, 1000)
  comment?: string;
}
