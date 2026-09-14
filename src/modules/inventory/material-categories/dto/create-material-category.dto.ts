import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class CreateMaterialCategoryDto {
  @ApiProperty({ example: 'Cement' })
  @IsString()
  @Length(1, 200)
  name!: string;
}
