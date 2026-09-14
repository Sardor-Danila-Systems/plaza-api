import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { AnalyticsPeriodQueryDto } from './analytics-period-query.dto.js';

export class MaterialsAnalyticsQueryDto extends AnalyticsPeriodQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  materialId?: string;
}
