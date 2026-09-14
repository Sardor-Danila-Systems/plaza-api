import { ApiProperty } from '@nestjs/swagger';
import { FinancialTransactionResponseDto } from './financial-transaction-response.dto.js';

export class PaginatedFinancialTransactionsResponseDto {
  @ApiProperty({ type: [FinancialTransactionResponseDto] })
  data!: FinancialTransactionResponseDto[];

  @ApiProperty({ description: 'Total matching rows across all pages.' })
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
