import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { IsBusinessDate } from '../../../common/validators/is-business-date.validator.js';

/** `[from, to)` on `occurredAt` — the same convention every other
 * date-filtered list/report in this codebase uses. Both bounds optional. */
export class ReportPeriodQueryDto {
  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsOptional()
  @IsBusinessDate()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @IsBusinessDate()
  dateTo?: string;
}
