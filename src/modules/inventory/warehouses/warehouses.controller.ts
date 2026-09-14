import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { ErrorResponseDto } from '../../../common/dto/error-response.dto.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { CreateWarehouseDto } from './dto/create-warehouse.dto.js';
import { UpdateWarehouseDto } from './dto/update-warehouse.dto.js';
import { WarehouseResponseDto } from './dto/warehouse-response.dto.js';
import { WarehousesService } from './warehouses.service.js';

/**
 * No `Idempotency-Key` requirement here (unlike finance postings):
 * docs/transaction-design.md §3 requires it specifically for purchase/
 * supplier-payment/advance/transfer and their cancellations — creating a
 * warehouse is master-data configuration, not a financial/inventory
 * posting, and a duplicate submission is corrected the same way any other
 * mistaken master-data row would be (archive it), not replayed. Mechanically
 * forcing the financial mechanism onto every CRUD endpoint was considered
 * and deliberately rejected (this phase's own §32).
 */
@ApiTags('inventory')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/warehouses')
export class WarehousesController {
  constructor(private readonly warehousesService: WarehousesService) {}

  @Get()
  @ApiOperation({ summary: 'List warehouses in a project' })
  @ApiOkResponse({ type: [WarehouseResponseDto] })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ): Promise<WarehouseResponseDto[]> {
    return this.warehousesService.list(user, projectId);
  }

  @Get(':warehouseId')
  @ApiOperation({ summary: 'Read one warehouse' })
  @ApiOkResponse({ type: WarehouseResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('warehouseId', ParseUUIDPipe) warehouseId: string,
  ): Promise<WarehouseResponseDto> {
    return this.warehousesService.get(user, projectId, warehouseId);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a warehouse',
    description: 'PROJECT_MANAGER of this project only.',
  })
  @ApiCreatedResponse({ type: WarehouseResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateWarehouseDto,
    @Req() req: Request,
  ): Promise<WarehouseResponseDto> {
    return this.warehousesService.create(user, projectId, dto, req.id);
  }

  @Patch(':warehouseId')
  @ApiOperation({
    summary: 'Update or archive/restore a warehouse',
    description: 'PROJECT_MANAGER of this project only.',
  })
  @ApiOkResponse({ type: WarehouseResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('warehouseId', ParseUUIDPipe) warehouseId: string,
    @Body() dto: UpdateWarehouseDto,
    @Req() req: Request,
  ): Promise<WarehouseResponseDto> {
    return this.warehousesService.update(
      user,
      projectId,
      warehouseId,
      dto,
      req.id,
    );
  }
}
