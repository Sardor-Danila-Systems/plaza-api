import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsString, Length } from 'class-validator';
import { TransactionCategoryKind } from '../../../../generated/prisma/client.js';

export class CreateTransactionCategoryDto {
  @ApiProperty({ example: 'Materials' })
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiProperty({ enum: TransactionCategoryKind })
  @IsEnum(TransactionCategoryKind)
  kind!: TransactionCategoryKind;
}
