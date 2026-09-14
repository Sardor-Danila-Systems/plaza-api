import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { IsBusinessDate } from '../../../common/validators/is-business-date.validator.js';

/**
 * `[from, to)` — the exact convention already used by every other
 * date-filtered list in this codebase (docs/backend-architecture.md §11).
 * Both bounds are optional: an omitted `dateFrom` means "since the
 * beginning of this project's history" (no lower bound at all, not `0`);
 * an omitted `dateTo` means "through today" for period aggregates, and "as
 * of right now" for the as-of-`to` reconstructions (supplier debt/advance,
 * historical inventory value).
 */
export class AnalyticsPeriodQueryDto {
  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsOptional()
  @IsBusinessDate()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @IsBusinessDate()
  dateTo?: string;
}
