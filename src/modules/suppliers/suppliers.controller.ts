import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
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
import { ErrorResponseDto } from '../../common/dto/error-response.dto.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { CreateSupplierDto } from './dto/create-supplier.dto.js';
import { ListSuppliersQueryDto } from './dto/list-suppliers-query.dto.js';
import { SupplierResponseDto } from './dto/supplier-response.dto.js';
import { UpdateSupplierDto } from './dto/update-supplier.dto.js';
import { SuppliersService } from './suppliers.service.js';

@ApiTags('suppliers')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/suppliers')
export class SuppliersController {
  constructor(private readonly suppliersService: SuppliersService) {}

  @Get()
  @ApiOperation({
    summary: 'List suppliers in a project',
    description:
      'Optionally filtered by active state and a case-insensitive search over name, contact person, phone and taxpayer id.',
  })
  @ApiOkResponse({ type: [SupplierResponseDto] })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: ListSuppliersQueryDto,
  ): Promise<SupplierResponseDto[]> {
    return this.suppliersService.list(user, projectId, query);
  }

  @Get(':supplierId')
  @ApiOperation({ summary: 'Read one supplier' })
  @ApiOkResponse({ type: SupplierResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('supplierId', ParseUUIDPipe) supplierId: string,
  ): Promise<SupplierResponseDto> {
    return this.suppliersService.get(user, projectId, supplierId);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a supplier',
    description: 'PROJECT_MANAGER of this project only.',
  })
  @ApiCreatedResponse({ type: SupplierResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateSupplierDto,
    @Req() req: Request,
  ): Promise<SupplierResponseDto> {
    return this.suppliersService.create(user, projectId, dto, req.id);
  }

  @Patch(':supplierId')
  @ApiOperation({
    summary: 'Update or archive/restore a supplier',
    description: 'PROJECT_MANAGER of this project only.',
  })
  @ApiOkResponse({ type: SupplierResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('supplierId', ParseUUIDPipe) supplierId: string,
    @Body() dto: UpdateSupplierDto,
    @Req() req: Request,
  ): Promise<SupplierResponseDto> {
    return this.suppliersService.update(
      user,
      projectId,
      supplierId,
      dto,
      req.id,
    );
  }
}
