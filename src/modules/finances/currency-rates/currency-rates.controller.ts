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
  ApiTags,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../../../common/dto/error-response.dto.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { CurrencyRatesService } from './currency-rates.service.js';
import { CreateCurrencyRateDto } from './dto/create-currency-rate.dto.js';
import { CurrencyRateResponseDto } from './dto/currency-rate-response.dto.js';

@ApiTags('finances')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/currency-rates')
export class CurrencyRatesController {
  constructor(private readonly currencyRatesService: CurrencyRatesService) {}

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
