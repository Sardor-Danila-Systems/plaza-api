import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class CancelPurchaseDto {
  @ApiProperty({
    example: 'Duplicate entry — the same invoice was posted twice',
  })
  @IsString()
  @Length(1, 1000)
  reason!: string;
}
