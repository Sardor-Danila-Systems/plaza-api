import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../../../common/dto/error-response.dto.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
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
    description:
      'Read-only — units are provisioned via seed data, not this API.',
  })
  @ApiOkResponse({ type: [UnitResponseDto] })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ): Promise<UnitResponseDto[]> {
    return this.unitsService.list(user, projectId);
  }
}
