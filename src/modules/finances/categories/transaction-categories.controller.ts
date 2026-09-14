import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
import { ErrorResponseDto } from '../../../common/dto/error-response.dto.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { CreateTransactionCategoryDto } from './dto/create-transaction-category.dto.js';
import { TransactionCategoryResponseDto } from './dto/transaction-category-response.dto.js';
import { UpdateTransactionCategoryDto } from './dto/update-transaction-category.dto.js';
import { TransactionCategoriesService } from './transaction-categories.service.js';

@ApiTags('finances')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/transaction-categories')
export class TransactionCategoriesController {
  constructor(
    private readonly categoriesService: TransactionCategoriesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List transaction categories in a project' })
  @ApiOkResponse({ type: [TransactionCategoryResponseDto] })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ): Promise<TransactionCategoryResponseDto[]> {
    return this.categoriesService.list(user, projectId);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a transaction category',
    description: 'PROJECT_MANAGER of this project only.',
  })
  @ApiCreatedResponse({ type: TransactionCategoryResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateTransactionCategoryDto,
  ): Promise<TransactionCategoryResponseDto> {
    return this.categoriesService.create(user, projectId, dto);
  }

  @Patch(':categoryId')
  @ApiOperation({
    summary: 'Rename or archive/restore a transaction category',
    description: 'PROJECT_MANAGER of this project only.',
  })
  @ApiOkResponse({ type: TransactionCategoryResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
    @Body() dto: UpdateTransactionCategoryDto,
  ): Promise<TransactionCategoryResponseDto> {
    return this.categoriesService.update(user, projectId, categoryId, dto);
  }
}
