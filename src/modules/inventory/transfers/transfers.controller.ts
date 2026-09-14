import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
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
import { IdempotencyKey } from '../../../common/decorators/idempotency-key.decorator.js';
import { ErrorResponseDto } from '../../../common/dto/error-response.dto.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { CancelTransferDto } from './dto/cancel-transfer.dto.js';
import { CreateTransferDto } from './dto/create-transfer.dto.js';
import { ListTransfersQueryDto } from './dto/list-transfers-query.dto.js';
import { PaginatedTransfersResponseDto } from './dto/paginated-transfers-response.dto.js';
import { TransferResponseDto } from './dto/transfer-response.dto.js';
import { TransfersService } from './transfers.service.js';

@ApiTags('inventory')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/inventory/transfers')
export class TransfersController {
  constructor(private readonly transfersService: TransfersService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Transfer material between two warehouses in one project',
    description:
      'Posts paired TRANSFER_OUT/TRANSFER_IN movements atomically. PROJECT_MANAGER of this project only.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: TransferResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    description:
      'INSUFFICIENT_STOCK | CROSS_PROJECT_TRANSFER_FORBIDDEN | IDEMPOTENCY_KEY_REUSED | CONCURRENT_MODIFICATION',
    type: ErrorResponseDto,
  })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateTransferDto,
    @IdempotencyKey() idempotencyKey: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TransferResponseDto> {
    const result = await this.transfersService.create(
      user,
      projectId,
      dto,
      idempotencyKey,
      req.id,
    );
    if (result.isReplay) {
      res.status(200);
    }
    return result.transfer;
  }

  @Get()
  @ApiOperation({ summary: 'List warehouse transfers in this project' })
  @ApiOkResponse({ type: PaginatedTransfersResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: ListTransfersQueryDto,
  ): Promise<PaginatedTransfersResponseDto> {
    return this.transfersService.list(user, projectId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one warehouse transfer by id' })
  @ApiOkResponse({ type: TransferResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TransferResponseDto> {
    return this.transfersService.get(user, projectId, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancel a warehouse transfer',
    description:
      'Posts both inverse legs atomically; rejected if either balance has a later effective movement. PROJECT_MANAGER of this project only.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOkResponse({ type: TransferResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    description:
      'TRANSFER_ALREADY_CANCELLED | CANCELLATION_HAS_DEPENDENCIES | IDEMPOTENCY_KEY_REUSED | CONCURRENT_MODIFICATION',
    type: ErrorResponseDto,
  })
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelTransferDto,
    @IdempotencyKey() idempotencyKey: string,
    @Req() req: Request,
  ): Promise<TransferResponseDto> {
    const result = await this.transfersService.cancel(
      user,
      projectId,
      id,
      dto,
      idempotencyKey,
      req.id,
    );
    return result.transfer;
  }
}
