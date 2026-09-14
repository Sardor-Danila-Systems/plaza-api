import { ApiProperty } from '@nestjs/swagger';
import { TransactionCategoryKind } from '../../../../generated/prisma/client.js';

export class TransactionCategoryResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  projectId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: TransactionCategoryKind })
  kind!: TransactionCategoryKind;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty()
  createdAt!: Date;
}
