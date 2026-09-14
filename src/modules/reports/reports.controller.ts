import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ErrorResponseDto } from '../../common/dto/error-response.dto.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { ReportPeriodQueryDto } from './dto/report-period-query.dto.js';
import { ReportsService } from './reports.service.js';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

@ApiTags('reports')
@ApiBearerAuth('access-token')
@ApiProduces(XLSX_MIME)
@Controller('projects/:projectId/reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('cash.xlsx')
  @ApiOperation({ summary: 'Cash ledger export' })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  async cash(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: ReportPeriodQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.reportsService.cashLedger(user, projectId, query, res);
  }

  @Get('purchases.xlsx')
  @ApiOperation({ summary: 'Purchases (including line items) export' })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  async purchases(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: ReportPeriodQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.reportsService.purchases(user, projectId, query, res);
  }

  @Get('suppliers.xlsx')
  @ApiOperation({
    summary: 'Suppliers, with current debt and available advance, export',
  })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  async suppliers(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.reportsService.suppliers(user, projectId, res);
  }

  @Get('debts.xlsx')
  @ApiOperation({ summary: 'Outstanding supplier debts export' })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  async debts(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.reportsService.debts(user, projectId, res);
  }

  @Get('advances.xlsx')
  @ApiOperation({ summary: 'Supplier advances export' })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  async advances(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.reportsService.advances(user, projectId, res);
  }

  @Get('inventory.xlsx')
  @ApiOperation({ summary: 'Current inventory balances export' })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  async inventory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.reportsService.inventory(user, projectId, res);
  }

  @Get('movements.xlsx')
  @ApiOperation({ summary: 'Stock movement history export' })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  async movements(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: ReportPeriodQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.reportsService.movements(user, projectId, query, res);
  }

  @Get('construction-usage.xlsx')
  @ApiOperation({ summary: 'Material consumption by block/floor export' })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  async constructionUsage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: ReportPeriodQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.reportsService.constructionUsage(user, projectId, query, res);
  }
}
