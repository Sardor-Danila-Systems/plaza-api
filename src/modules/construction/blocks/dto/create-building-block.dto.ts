import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

export class CreateBuildingBlockDto {
  @ApiProperty({ example: 'Block A' })
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiProperty({
    example: 'block-a',
    description: 'Stable per-project identifier. Immutable once created.',
  })
  @IsString()
  @Length(1, 100)
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message:
      'code must be lowercase kebab-case (letters, digits, single hyphens)',
  })
  code!: string;
}
