import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
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
import { AuditQueryService } from './audit-query.service.js';
import { AuditLogResponseDto } from './dto/audit-log-response.dto.js';
import { ListAuditQueryDto } from './dto/list-audit-query.dto.js';
import { PaginatedAuditResponseDto } from './dto/paginated-audit-response.dto.js';

@ApiTags('audit')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/audit')
export class AuditController {
  constructor(private readonly auditQueryService: AuditQueryService) {}

  @Get()
  @ApiOperation({
    summary: "A project's audit trail",
    description:
      'Read-only. PROJECT_MANAGER: own project. OWNER/ACCOUNTANT: any active project.',
  })
  @ApiOkResponse({ type: PaginatedAuditResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: ListAuditQueryDto,
  ): Promise<PaginatedAuditResponseDto> {
    return this.auditQueryService.list(user, projectId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one audit log entry by id' })
  @ApiOkResponse({ type: AuditLogResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AuditLogResponseDto> {
    return this.auditQueryService.get(user, projectId, id);
  }
}
