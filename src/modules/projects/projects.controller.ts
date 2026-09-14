import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/dto/error-response.dto.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { ProjectResponseDto } from './dto/project-response.dto.js';
import { ProjectsService } from './projects.service.js';

/**
 * Read-only for every role, including PROJECT_MANAGER (Phase 3.1 correction:
 * a manager's operational write access to their own project's *content*
 * (blocks, floors, and — from Phase 4 — finances/inventory/etc.) does not
 * extend to the project's own *identity/administrative metadata*
 * (name/code/timezone/active state/manager assignment). Project creation and
 * ALL project metadata changes, including rename, go through the controlled
 * provisioning mechanism only — see ADR 0014. There is no PATCH here, and
 * none should be added without an explicit approved business requirement;
 * OWNER never gains a write path as a substitute.
 */
@ApiTags('projects')
@ApiBearerAuth('access-token')
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Get()
  @ApiOperation({
    summary: 'List projects visible to the current user',
    description:
      'OWNER/ACCOUNTANT see all active projects. PROJECT_MANAGER sees only their assigned project.',
  })
  @ApiOkResponse({ type: [ProjectResponseDto] })
  list(@CurrentUser() user: AuthenticatedUser): Promise<ProjectResponseDto[]> {
    return this.projectsService.listForUser(user);
  }

  @Get(':projectId')
  @ApiOperation({ summary: 'Read one project' })
  @ApiOkResponse({ type: ProjectResponseDto })
  @ApiForbiddenResponse({
    description: 'PROJECT_MANAGER requesting a project other than their own',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Project does not exist or is inactive',
    type: ErrorResponseDto,
  })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ): Promise<ProjectResponseDto> {
    return this.projectsService.getForUser(user, projectId);
  }
}
