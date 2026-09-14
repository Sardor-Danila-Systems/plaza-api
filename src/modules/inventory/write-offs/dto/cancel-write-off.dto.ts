import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class CancelWriteOffDto {
  @ApiProperty({ example: 'Recorded against the wrong floor' })
  @IsString()
  @Length(1, 1000)
  reason!: string;
}
