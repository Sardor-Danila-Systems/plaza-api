import { ApiProperty } from '@nestjs/swagger';
import { TransferResponseDto } from './transfer-response.dto.js';

export class PaginatedTransfersResponseDto {
  @ApiProperty({ type: [TransferResponseDto] })
  data!: TransferResponseDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
