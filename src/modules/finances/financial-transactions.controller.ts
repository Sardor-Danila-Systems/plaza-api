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
import { BalanceResponseDto } from './dto/balance-response.dto.js';
import { CancelFinancialTransactionDto } from './dto/cancel-financial-transaction.dto.js';
import { CreateFinancialTransactionDto } from './dto/create-financial-transaction.dto.js';
import { EditCommentDto } from './dto/edit-comment.dto.js';
import { FinancialTransactionResponseDto } from './dto/financial-transaction-response.dto.js';
import { ListFinancialTransactionsQueryDto } from './dto/list-financial-transactions-query.dto.js';
import { PaginatedFinancialTransactionsResponseDto } from './dto/paginated-financial-transactions-response.dto.js';
import { FinancialPostingService } from './financial-posting.service.js';

@ApiTags('finances')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/finances')
export class FinancialTransactionsController {
  constructor(private readonly financialPosting: FinancialPostingService) {}

  @Get('balance')
  @ApiOperation({ summary: 'Current nominal cash balance, per currency' })
  @ApiOkResponse({ type: BalanceResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  getBalance(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ): Promise<BalanceResponseDto> {
    return this.financialPosting.getBalance(user, projectId);
  }

  @Get()
  @ApiOperation({ summary: 'List financial transactions in a project' })
  @ApiOkResponse({ type: PaginatedFinancialTransactionsResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: ListFinancialTransactionsQueryDto,
  ): Promise<PaginatedFinancialTransactionsResponseDto> {
    return this.financialPosting.list(user, projectId, query);
  }

  @Get(':transactionId')
  @ApiOperation({ summary: 'Read one financial transaction' })
  @ApiOkResponse({ type: FinancialTransactionResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('transactionId', ParseUUIDPipe) transactionId: string,
  ): Promise<FinancialTransactionResponseDto> {
    return this.financialPosting.get(user, projectId, transactionId);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Post an income, expense, or salary transaction',
    description: 'PROJECT_MANAGER of this project only.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Client-generated opaque key; a retried request with the same key and payload returns the original result (200) instead of creating a duplicate.',
  })
  @ApiCreatedResponse({ type: FinancialTransactionResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    description:
      'INSUFFICIENT_CASH | IDEMPOTENCY_KEY_REUSED | CONCURRENT_MODIFICATION',
    type: ErrorResponseDto,
  })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateFinancialTransactionDto,
    @IdempotencyKey() idempotencyKey: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FinancialTransactionResponseDto> {
    const result = await this.financialPosting.create(
      user,
      projectId,
      dto,
      idempotencyKey,
      req.id,
    );
    if (result.isReplay) {
      res.status(200);
    }
    return result.transaction;
  }

  @Patch(':transactionId')
  @ApiOperation({
    summary: 'Edit a financial transaction comment',
    description:
      'PROJECT_MANAGER of this project only. Comment only — every other field is immutable.',
  })
  @ApiOkResponse({ type: FinancialTransactionResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  editComment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('transactionId', ParseUUIDPipe) transactionId: string,
    @Body() dto: EditCommentDto,
    @Req() req: Request,
  ): Promise<FinancialTransactionResponseDto> {
    return this.financialPosting.editComment(
      user,
      projectId,
      transactionId,
      dto,
      req.id,
    );
  }

  @Post(':transactionId/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancel a financial transaction',
    description:
      'PROJECT_MANAGER of this project only. Creates an exact inverse entry; the original is retained and marked cancelled, never deleted.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated opaque key.',
  })
  @ApiOkResponse({ type: FinancialTransactionResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    description:
      'TRANSACTION_ALREADY_CANCELLED | INSUFFICIENT_CASH | IDEMPOTENCY_KEY_REUSED | CONCURRENT_MODIFICATION',
    type: ErrorResponseDto,
  })
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('transactionId', ParseUUIDPipe) transactionId: string,
    @Body() dto: CancelFinancialTransactionDto,
    @IdempotencyKey() idempotencyKey: string,
    @Req() req: Request,
  ): Promise<FinancialTransactionResponseDto> {
    const result = await this.financialPosting.cancel(
      user,
      projectId,
      transactionId,
      dto,
      idempotencyKey,
      req.id,
    );
    return result.transaction;
  }
}
