import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class CancelTransferDto {
  @ApiProperty({ example: 'Sent to the wrong destination warehouse' })
  @IsString()
  @Length(1, 1000)
  reason!: string;
}
