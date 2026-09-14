import { ApiProperty } from '@nestjs/swagger';
import { WriteOffResponseDto } from './write-off-response.dto.js';

export class PaginatedWriteOffsResponseDto {
  @ApiProperty({ type: [WriteOffResponseDto] })
  data!: WriteOffResponseDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
