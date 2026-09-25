import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches } from 'class-validator';

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

  @ApiProperty({
    example: '123456789',
    required: false,
    description:
      'Uzbek taxpayer id (ИНН/СТИР): exactly nine digits, or omitted.',
  })
  @IsOptional()
  @Matches(/^\d{9}$/, {
    message: 'taxId must be exactly nine digits',
  })
  taxId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(1, 1000)
  comment?: string;
}
