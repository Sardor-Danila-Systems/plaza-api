import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/dto/error-response.dto.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { AnalyticsService } from './analytics.service.js';
import { AnalyticsPeriodQueryDto } from './dto/analytics-period-query.dto.js';
import { AnalyticsSummaryResponseDto } from './dto/analytics-summary-response.dto.js';
import { ConstructionAnalyticsQueryDto } from './dto/construction-analytics-query.dto.js';
import { ConstructionAnalyticsResponseDto } from './dto/construction-analytics-response.dto.js';
import { MaterialsAnalyticsQueryDto } from './dto/materials-analytics-query.dto.js';
import { MaterialsAnalyticsResponseDto } from './dto/material-analytics-response.dto.js';

@ApiTags('analytics')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('summary')
  @ApiOperation({
    summary:
      'Cash, expenses, purchases, supplier debt/advances, and inventory value',
    description:
      'Read-only. PROJECT_MANAGER: own project. OWNER/ACCOUNTANT: any active project.',
  })
  @ApiOkResponse({ type: AnalyticsSummaryResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  async summary(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: AnalyticsPeriodQueryDto,
  ): Promise<AnalyticsSummaryResponseDto> {
    return this.analyticsService.getSummary(user, projectId, query);
  }

  @Get('materials')
  @ApiOperation({
    summary: 'Per-material purchased and consumed quantity/value',
  })
  @ApiOkResponse({ type: MaterialsAnalyticsResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  async materials(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: MaterialsAnalyticsQueryDto,
  ): Promise<MaterialsAnalyticsResponseDto> {
    return this.analyticsService.getMaterials(user, projectId, query);
  }

  @Get('construction')
  @ApiOperation({ summary: 'Material consumption by block and floor' })
  @ApiOkResponse({ type: ConstructionAnalyticsResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  async construction(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: ConstructionAnalyticsQueryDto,
  ): Promise<ConstructionAnalyticsResponseDto> {
    return this.analyticsService.getConstruction(user, projectId, query);
  }
}
