import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ErrorResponseDto } from '../../../common/dto/error-response.dto.js';
import { IdempotencyKey } from '../../../common/decorators/idempotency-key.decorator.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { CreateSupplierAdvanceDto } from './dto/create-supplier-advance.dto.js';
import { SupplierAdvanceResponseDto } from './dto/supplier-advance-response.dto.js';
import { SupplierAdvancesService } from './supplier-advances.service.js';

@ApiTags('suppliers')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/suppliers/:supplierId/advances')
export class SupplierAdvancesController {
  constructor(private readonly advancesService: SupplierAdvancesService) {}

  @Get()
  @ApiOperation({
    summary: 'List a supplier’s advances with their remaining balances',
  })
  @ApiOkResponse({ type: [SupplierAdvanceResponseDto] })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('supplierId', ParseUUIDPipe) supplierId: string,
  ): Promise<SupplierAdvanceResponseDto[]> {
    return this.advancesService.list(user, projectId, supplierId);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Fund a supplier advance',
    description: 'PROJECT_MANAGER of this project only.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: SupplierAdvanceResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    description:
      'INSUFFICIENT_CASH | IDEMPOTENCY_KEY_REUSED | CONCURRENT_MODIFICATION',
    type: ErrorResponseDto,
  })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('supplierId', ParseUUIDPipe) supplierId: string,
    @Body() dto: CreateSupplierAdvanceDto,
    @IdempotencyKey() idempotencyKey: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SupplierAdvanceResponseDto> {
    const result = await this.advancesService.create(
      user,
      projectId,
      supplierId,
      dto,
      idempotencyKey,
      req.id,
    );
    if (result.isReplay) {
      res.status(200);
    }
    return result.advance;
  }
}
