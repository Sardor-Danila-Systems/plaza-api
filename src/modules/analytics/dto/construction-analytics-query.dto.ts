import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { AnalyticsPeriodQueryDto } from './analytics-period-query.dto.js';

export class ConstructionAnalyticsQueryDto extends AnalyticsPeriodQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  blockId?: string;

  /** Exact floor only. Mutually exclusive with `wholeBlockOnly` (the
   * service rejects both set at once) — a StockWriteOff row has exactly
   * one of a specific floor or a NULL floor, never both. */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  floorId?: string;

  /**
   * Explicit semantic for "whole-block write-offs only" (`floorId IS
   * NULL`) — deliberately not a magic UUID sentinel passed as `floorId`.
   * Omitting both this and `floorId` returns both floor-specific and
   * whole-block rows, matching current behavior; setting this to `true`
   * narrows to whole-block rows only (scoped to `blockId` if that's also
   * given, otherwise across every block in the project).
   */
  @ApiPropertyOptional({
    description:
      'When true, return only whole-block write-offs (floorId IS NULL) — mutually exclusive with floorId.',
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  wholeBlockOnly?: boolean;
}
