import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateIf,
} from 'class-validator';

export class UpdateSupplierDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  /**
   * `contactPerson`/`phone`/`taxId`/`comment` are all optional AND
   * clearable: omitting the key leaves the field untouched (the service
   * only writes keys that are `!== undefined`), while `null` explicitly
   * clears it. Before this, there was no way to represent "clear" at all —
   * an empty string failed `@Length(1, ...)`/`@Matches` with a 400, and
   * `undefined` was indistinguishable from "not provided", so the
   * frontend's edit form silently no-op'd when a user cleared a field.
   * `@ValidateIf` skips the format check specifically for `null`, while
   * `@IsOptional` still allows the key to be absent entirely.
   */
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @Length(1, 200)
  contactPerson?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @Length(1, 50)
  phone?: string | null;

  @ApiPropertyOptional({
    example: '123456789',
    nullable: true,
    description:
      'Uzbek taxpayer id (ИНН/СТИР): exactly nine digits, omitted (leave unchanged), or null (clear it).',
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @Matches(/^\d{9}$/, {
    message: 'taxId must be exactly nine digits',
  })
  taxId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @Length(1, 1000)
  comment?: string | null;

  @ApiPropertyOptional({ description: 'Archive (false) or restore (true).' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
