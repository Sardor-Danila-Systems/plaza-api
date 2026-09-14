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
import { ErrorResponseDto } from '../../../common/dto/error-response.dto.js';
import { IdempotencyKey } from '../../../common/decorators/idempotency-key.decorator.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { CancelWriteOffDto } from './dto/cancel-write-off.dto.js';
import { CreateWriteOffDto } from './dto/create-write-off.dto.js';
import { ListWriteOffsQueryDto } from './dto/list-write-offs-query.dto.js';
import { PaginatedWriteOffsResponseDto } from './dto/paginated-write-offs-response.dto.js';
import { WriteOffResponseDto } from './dto/write-off-response.dto.js';
import { WriteOffsService } from './write-offs.service.js';

@ApiTags('inventory')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/inventory/write-offs')
export class WriteOffsController {
  constructor(private readonly writeOffsService: WriteOffsService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Write off material consumed by a block/floor',
    description: 'PROJECT_MANAGER of this project only.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: WriteOffResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    description:
      'INSUFFICIENT_STOCK | IDEMPOTENCY_KEY_REUSED | CONCURRENT_MODIFICATION',
    type: ErrorResponseDto,
  })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateWriteOffDto,
    @IdempotencyKey() idempotencyKey: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WriteOffResponseDto> {
    const result = await this.writeOffsService.create(
      user,
      projectId,
      dto,
      idempotencyKey,
      req.id,
    );
    if (result.isReplay) {
      res.status(200);
    }
    return result.writeOff;
  }

  @Get()
  @ApiOperation({ summary: 'List write-offs in this project' })
  @ApiOkResponse({ type: PaginatedWriteOffsResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: ListWriteOffsQueryDto,
  ): Promise<PaginatedWriteOffsResponseDto> {
    return this.writeOffsService.list(user, projectId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one write-off by id' })
  @ApiOkResponse({ type: WriteOffResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WriteOffResponseDto> {
    return this.writeOffsService.get(user, projectId, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancel a write-off',
    description:
      'Restores the balance it depleted; rejected if a later operation depends on it. PROJECT_MANAGER of this project only.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOkResponse({ type: WriteOffResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    description:
      'WRITE_OFF_ALREADY_CANCELLED | CANCELLATION_HAS_DEPENDENCIES | IDEMPOTENCY_KEY_REUSED | CONCURRENT_MODIFICATION',
    type: ErrorResponseDto,
  })
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelWriteOffDto,
    @IdempotencyKey() idempotencyKey: string,
    @Req() req: Request,
  ): Promise<WriteOffResponseDto> {
    const result = await this.writeOffsService.cancel(
      user,
      projectId,
      id,
      dto,
      idempotencyKey,
      req.id,
    );
    return result.writeOff;
  }
}
