import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

export class UpdateSupplierDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  contactPerson?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 50)
  phone?: string;

  @ApiPropertyOptional({
    example: '123456789',
    description:
      'Uzbek taxpayer id (ИНН/СТИР): exactly nine digits, or omitted.',
  })
  @IsOptional()
  @Matches(/^\d{9}$/, {
    message: 'taxId must be exactly nine digits',
  })
  taxId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 1000)
  comment?: string;

  @ApiPropertyOptional({ description: 'Archive (false) or restore (true).' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
