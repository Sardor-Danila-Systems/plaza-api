import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class CancelFinancialTransactionDto {
  @ApiProperty({
    example: 'Duplicate entry — the same payment was posted twice',
  })
  @IsString()
  @Length(1, 1000)
  reason!: string;
}
