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
import { BlocksService } from './blocks.service.js';
import { BuildingBlockResponseDto } from './dto/building-block-response.dto.js';
import { CreateBuildingBlockDto } from './dto/create-building-block.dto.js';
import { UpdateBuildingBlockDto } from './dto/update-building-block.dto.js';

@ApiTags('construction')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/construction/blocks')
export class BlocksController {
  constructor(private readonly blocksService: BlocksService) {}

  @Get()
  @ApiOperation({ summary: 'List building blocks in a project' })
  @ApiOkResponse({ type: [BuildingBlockResponseDto] })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ): Promise<BuildingBlockResponseDto[]> {
    return this.blocksService.list(user, projectId);
  }

  @Get(':blockId')
  @ApiOperation({ summary: 'Read one building block' })
  @ApiOkResponse({ type: BuildingBlockResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({
    description: 'BLOCK_PROJECT_MISMATCH',
    type: ErrorResponseDto,
  })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('blockId', ParseUUIDPipe) blockId: string,
  ): Promise<BuildingBlockResponseDto> {
    return this.blocksService.get(user, projectId, blockId);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a building block',
    description: 'PROJECT_MANAGER of this project only.',
  })
  @ApiCreatedResponse({ type: BuildingBlockResponseDto })
  @ApiForbiddenResponse({
    description: 'Not this project’s manager',
    type: ErrorResponseDto,
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateBuildingBlockDto,
  ): Promise<BuildingBlockResponseDto> {
    return this.blocksService.create(user, projectId, dto);
  }

  @Patch(':blockId')
  @ApiOperation({
    summary: 'Update or archive/restore a building block',
    description: 'PROJECT_MANAGER of this project only.',
  })
  @ApiOkResponse({ type: BuildingBlockResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({
    description: 'BLOCK_PROJECT_MISMATCH',
    type: ErrorResponseDto,
  })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('blockId', ParseUUIDPipe) blockId: string,
    @Body() dto: UpdateBuildingBlockDto,
  ): Promise<BuildingBlockResponseDto> {
    return this.blocksService.update(user, projectId, blockId, dto);
  }
}
