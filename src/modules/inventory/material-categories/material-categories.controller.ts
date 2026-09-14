import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
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
import { CreateMaterialCategoryDto } from './dto/create-material-category.dto.js';
import { MaterialCategoryResponseDto } from './dto/material-category-response.dto.js';
import { UpdateMaterialCategoryDto } from './dto/update-material-category.dto.js';
import { MaterialCategoriesService } from './material-categories.service.js';

@ApiTags('inventory')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/material-categories')
export class MaterialCategoriesController {
  constructor(private readonly categoriesService: MaterialCategoriesService) {}

  @Get()
  @ApiOperation({ summary: 'List material categories in a project' })
  @ApiOkResponse({ type: [MaterialCategoryResponseDto] })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ): Promise<MaterialCategoryResponseDto[]> {
    return this.categoriesService.list(user, projectId);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a material category',
    description: 'PROJECT_MANAGER of this project only.',
  })
  @ApiCreatedResponse({ type: MaterialCategoryResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateMaterialCategoryDto,
    @Req() req: Request,
  ): Promise<MaterialCategoryResponseDto> {
    return this.categoriesService.create(user, projectId, dto, req.id);
  }

  @Patch(':categoryId')
  @ApiOperation({
    summary: 'Rename or archive/restore a material category',
    description: 'PROJECT_MANAGER of this project only.',
  })
  @ApiOkResponse({ type: MaterialCategoryResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
    @Body() dto: UpdateMaterialCategoryDto,
    @Req() req: Request,
  ): Promise<MaterialCategoryResponseDto> {
    return this.categoriesService.update(user, projectId, categoryId, dto, req.id);
  }
}
