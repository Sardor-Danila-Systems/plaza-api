import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { ErrorResponseDto } from '../../../common/dto/error-response.dto.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { CreateUnitDto } from './dto/create-unit.dto.js';
import { UnitResponseDto } from './dto/unit-response.dto.js';
import { UnitsService } from './units.service.js';

@ApiTags('inventory')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/units')
export class UnitsController {
  constructor(private readonly unitsService: UnitsService) {}

  @Get()
  @ApiOperation({
    summary: 'List units of measure in a project',
    description: 'Standard units are seeded; managers can add more via POST.',
  })
  @ApiOkResponse({ type: [UnitResponseDto] })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ): Promise<UnitResponseDto[]> {
    return this.unitsService.list(user, projectId);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a unit of measure',
    description: 'PROJECT_MANAGER of this project only. Symbol is unique per project.',
  })
  @ApiCreatedResponse({ type: UnitResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateUnitDto,
    @Req() req: Request,
  ): Promise<UnitResponseDto> {
    return this.unitsService.create(user, projectId, dto, req.id);
  }
}
