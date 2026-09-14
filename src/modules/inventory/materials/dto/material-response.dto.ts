import { ApiProperty } from '@nestjs/swagger';

export class MaterialResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  projectId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty({ format: 'uuid' })
  categoryId!: string;

  @ApiProperty({ format: 'uuid' })
  unitId!: string;

  @ApiProperty({ nullable: true, example: '100.000000' })
  minimumStock!: string | null;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty()
  createdAt!: Date;
}
