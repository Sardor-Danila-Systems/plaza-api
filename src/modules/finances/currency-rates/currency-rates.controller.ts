import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../../../common/dto/error-response.dto.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { CurrencyRatesService } from './currency-rates.service.js';
import { CreateCurrencyRateDto } from './dto/create-currency-rate.dto.js';
import { CurrencyRateResponseDto } from './dto/currency-rate-response.dto.js';
import { LiveCurrencyRateResponseDto } from './dto/live-currency-rate-response.dto.js';

@ApiTags('finances')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/currency-rates')
export class CurrencyRatesController {
  constructor(private readonly currencyRatesService: CurrencyRatesService) {}

  @Get('live')
  @ApiOperation({
    summary: 'Current official USD/UZS quote from the Central Bank of Uzbekistan',
    description:
      'Read-only — does not write a CurrencyRate row. Cached server-side for ~45 minutes.',
  })
  @ApiOkResponse({ type: LiveCurrencyRateResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiServiceUnavailableResponse({ type: ErrorResponseDto })
  getLive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ): Promise<LiveCurrencyRateResponseDto> {
    return this.currencyRatesService.getLiveRate(user, projectId);
  }

  @Get()
  @ApiOperation({ summary: 'List historical currency quotes for a project' })
  @ApiOkResponse({ type: [CurrencyRateResponseDto] })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ): Promise<CurrencyRateResponseDto[]> {
    return this.currencyRatesService.list(user, projectId);
  }

  @Post()
  @ApiOperation({
    summary: 'Record a manual currency quote',
    description: 'PROJECT_MANAGER of this project only. Append-only.',
  })
  @ApiCreatedResponse({ type: CurrencyRateResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateCurrencyRateDto,
  ): Promise<CurrencyRateResponseDto> {
    return this.currencyRatesService.create(user, projectId, dto);
  }
}
