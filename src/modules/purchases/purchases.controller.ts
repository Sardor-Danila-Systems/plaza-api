import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
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
import { ErrorResponseDto } from '../../common/dto/error-response.dto.js';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { EditCommentDto } from '../finances/dto/edit-comment.dto.js';
import { CancelPurchaseDto } from './dto/cancel-purchase.dto.js';
import { CreatePurchaseDto } from './dto/create-purchase.dto.js';
import { ListPurchasesQueryDto } from './dto/list-purchases-query.dto.js';
import { PaginatedPurchasesResponseDto } from './dto/paginated-purchases-response.dto.js';
import { PurchaseResponseDto } from './dto/purchase-response.dto.js';
import { PurchasesService } from './purchases.service.js';

@ApiTags('purchases')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/purchases')
export class PurchasesController {
  constructor(private readonly purchasesService: PurchasesService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Post a purchase (invoice + material receipt + settlement)',
    description: 'PROJECT_MANAGER of this project only.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: PurchaseResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    description:
      'INSUFFICIENT_CASH | ADVANCE_EXCEEDS_AVAILABLE | DEBT_PAYMENT_EXCEEDS_REMAINING | SETTLEMENT_RATE_REQUIRED | IDEMPOTENCY_KEY_REUSED | CONCURRENT_MODIFICATION',
    type: ErrorResponseDto,
  })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreatePurchaseDto,
    @IdempotencyKey() idempotencyKey: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PurchaseResponseDto> {
    const result = await this.purchasesService.create(
      user,
      projectId,
      dto,
      idempotencyKey,
      req.id,
    );
    if (result.isReplay) {
      res.status(200);
    }
    return result.purchase;
  }

  @Get()
  @ApiOperation({ summary: 'List purchases in this project' })
  @ApiOkResponse({ type: PaginatedPurchasesResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: ListPurchasesQueryDto,
  ): Promise<PaginatedPurchasesResponseDto> {
    return this.purchasesService.list(user, projectId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one purchase by id' })
  @ApiOkResponse({ type: PurchaseResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PurchaseResponseDto> {
    return this.purchasesService.get(user, projectId, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: "Edit a purchase's comment",
    description:
      'Comment only — every other posted field is immutable. PROJECT_MANAGER of this project only.',
  })
  @ApiOkResponse({ type: PurchaseResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async editComment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditCommentDto,
    @Req() req: Request,
  ): Promise<PurchaseResponseDto> {
    return this.purchasesService.editComment(user, projectId, id, dto, req.id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancel a purchase',
    description:
      'Reverses its inventory receipt and settlement in one transaction; rejected if a later operation depends on it. PROJECT_MANAGER of this project only.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOkResponse({ type: PurchaseResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    description:
      'PURCHASE_ALREADY_CANCELLED | PURCHASE_HAS_DEPENDENT_MOVEMENTS | INSUFFICIENT_CASH | IDEMPOTENCY_KEY_REUSED | CONCURRENT_MODIFICATION',
    type: ErrorResponseDto,
  })
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelPurchaseDto,
    @IdempotencyKey() idempotencyKey: string,
    @Req() req: Request,
  ): Promise<PurchaseResponseDto> {
    const result = await this.purchasesService.cancel(
      user,
      projectId,
      id,
      dto,
      idempotencyKey,
      req.id,
    );
    return result.purchase;
  }
}
