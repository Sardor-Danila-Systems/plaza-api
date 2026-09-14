import { ApiProperty } from '@nestjs/swagger';
import { PurchaseResponseDto } from './purchase-response.dto.js';

export class PaginatedPurchasesResponseDto {
  @ApiProperty({ type: [PurchaseResponseDto] })
  data!: PurchaseResponseDto[];

  @ApiProperty({ description: 'Total matching rows across all pages.' })
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
