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
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../../../common/dto/error-response.dto.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { CreateFloorDto } from './dto/create-floor.dto.js';
import { CreateFloorsBulkDto } from './dto/create-floors-bulk.dto.js';
import { FloorResponseDto } from './dto/floor-response.dto.js';
import { UpdateFloorDto } from './dto/update-floor.dto.js';
import { FloorsService } from './floors.service.js';

@ApiTags('construction')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/construction/blocks/:blockId/floors')
export class FloorsController {
  constructor(private readonly floorsService: FloorsService) {}

  @Get()
  @ApiOperation({ summary: 'List floors in a building block' })
  @ApiOkResponse({ type: [FloorResponseDto] })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({
    description: 'BLOCK_PROJECT_MISMATCH',
    type: ErrorResponseDto,
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('blockId', ParseUUIDPipe) blockId: string,
  ): Promise<FloorResponseDto[]> {
    return this.floorsService.list(user, projectId, blockId);
  }

  @Get(':floorId')
  @ApiOperation({ summary: 'Read one floor' })
  @ApiOkResponse({ type: FloorResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({
    description:
      'BLOCK_PROJECT_MISMATCH / FLOOR_BLOCK_MISMATCH / FLOOR_PROJECT_MISMATCH',
    type: ErrorResponseDto,
  })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('blockId', ParseUUIDPipe) blockId: string,
    @Param('floorId', ParseUUIDPipe) floorId: string,
  ): Promise<FloorResponseDto> {
    return this.floorsService.get(user, projectId, blockId, floorId);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a floor',
    description: 'PROJECT_MANAGER of this project only.',
  })
  @ApiCreatedResponse({ type: FloorResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({
    description: 'BLOCK_PROJECT_MISMATCH',
    type: ErrorResponseDto,
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('blockId', ParseUUIDPipe) blockId: string,
    @Body() dto: CreateFloorDto,
  ): Promise<FloorResponseDto> {
    return this.floorsService.create(user, projectId, blockId, dto);
  }

  @Post('bulk')
  @ApiOperation({
    summary: 'Add several floors to a building block at once',
    description:
      'PROJECT_MANAGER of this project only. All-or-nothing: one transaction covers every label in the payload.',
  })
  @ApiCreatedResponse({ type: [FloorResponseDto] })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({
    description: 'BLOCK_PROJECT_MISMATCH',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'FLOOR_LABEL_TAKEN',
    type: ErrorResponseDto,
  })
  createBulk(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('blockId', ParseUUIDPipe) blockId: string,
    @Body() dto: CreateFloorsBulkDto,
  ): Promise<FloorResponseDto[]> {
    return this.floorsService.createBulk(user, projectId, blockId, dto);
  }

  @Patch(':floorId')
  @ApiOperation({
    summary: 'Update or archive/restore a floor',
    description: 'PROJECT_MANAGER of this project only.',
  })
  @ApiOkResponse({ type: FloorResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({
    description:
      'BLOCK_PROJECT_MISMATCH / FLOOR_BLOCK_MISMATCH / FLOOR_PROJECT_MISMATCH',
    type: ErrorResponseDto,
  })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('blockId', ParseUUIDPipe) blockId: string,
    @Param('floorId', ParseUUIDPipe) floorId: string,
    @Body() dto: UpdateFloorDto,
  ): Promise<FloorResponseDto> {
    return this.floorsService.update(user, projectId, blockId, floorId, dto);
  }
}
