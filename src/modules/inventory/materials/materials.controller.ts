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
import { ErrorResponseDto } from '../../../common/dto/error-response.dto.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { CreateMaterialDto } from './dto/create-material.dto.js';
import { ListMaterialsQueryDto } from './dto/list-materials-query.dto.js';
import { MaterialResponseDto } from './dto/material-response.dto.js';
import { UpdateMaterialDto } from './dto/update-material.dto.js';
import { MaterialsService } from './materials.service.js';

@ApiTags('inventory')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/materials')
export class MaterialsController {
  constructor(private readonly materialsService: MaterialsService) {}

  @Get()
  @ApiOperation({ summary: 'List materials in a project' })
  @ApiOkResponse({ type: [MaterialResponseDto] })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: ListMaterialsQueryDto,
  ): Promise<MaterialResponseDto[]> {
    return this.materialsService.list(user, projectId, query);
  }

  @Get(':materialId')
  @ApiOperation({ summary: 'Read one material' })
  @ApiOkResponse({ type: MaterialResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('materialId', ParseUUIDPipe) materialId: string,
  ): Promise<MaterialResponseDto> {
    return this.materialsService.get(user, projectId, materialId);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a material',
    description: 'PROJECT_MANAGER of this project only.',
  })
  @ApiCreatedResponse({ type: MaterialResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateMaterialDto,
    @Req() req: Request,
  ): Promise<MaterialResponseDto> {
    return this.materialsService.create(user, projectId, dto, req.id);
  }

  @Patch(':materialId')
  @ApiOperation({
    summary: 'Update or archive/restore a material',
    description:
      'PROJECT_MANAGER of this project only. code and unitId are immutable once created.',
  })
  @ApiOkResponse({ type: MaterialResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('materialId', ParseUUIDPipe) materialId: string,
    @Body() dto: UpdateMaterialDto,
    @Req() req: Request,
  ): Promise<MaterialResponseDto> {
    return this.materialsService.update(
      user,
      projectId,
      materialId,
      dto,
      req.id,
    );
  }
}
