import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { AnalyticsPeriodQueryDto } from './analytics-period-query.dto.js';

export class ConstructionAnalyticsQueryDto extends AnalyticsPeriodQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  blockId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  floorId?: string;
}
