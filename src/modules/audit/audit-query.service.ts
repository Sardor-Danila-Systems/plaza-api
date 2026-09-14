import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { AuditLog, Prisma } from '../../generated/prisma/client.js';
import { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { ProjectAccessAction } from '../projects/project-access-action.enum.js';
import { ProjectAccessService } from '../projects/project-access.service.js';
import { AuditLogResponseDto } from './dto/audit-log-response.dto.js';
import { ListAuditQueryDto } from './dto/list-audit-query.dto.js';
import { PaginatedAuditResponseDto } from './dto/paginated-audit-response.dto.js';

/**
 * `GET P/audit` — the read side ADR 0016 deliberately deferred to Phase 9.
 * Read-only by design (docs/backend-architecture.md §10: "the transactional
 * writer" is the only way a row is ever created); this service has no
 * create/update/delete method at all, only `list`/`get`, so there is no
 * mutation surface to even guard against.
 */
@Injectable()
export class AuditQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  async list(
    user: AuthenticatedUser,
    projectId: string,
    query: ListAuditQueryDto,
  ): Promise<PaginatedAuditResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );

    const where: Prisma.AuditLogWhereInput = { projectId };
    if (query.actorId) {
      where.actorId = query.actorId;
    }
    if (query.action) {
      where.action = query.action;
    }
    if (query.entityType) {
      where.entityType = query.entityType;
    }
    if (query.entityId) {
      where.entityId = query.entityId;
    }
    if (query.dateFrom || query.dateTo) {
      where.createdAt = {
        ...(query.dateFrom
          ? { gte: new Date(`${query.dateFrom}T00:00:00.000Z`) }
          : {}),
        ...(query.dateTo
          ? { lt: new Date(`${query.dateTo}T00:00:00.000Z`) }
          : {}),
      };
    }

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [rows, total] = await Promise.all([
      this.prisma.client.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.client.auditLog.count({ where }),
    ]);

    return {
      data: rows.map((row) => this.toResponse(row)),
      total,
      page,
      pageSize,
    };
  }

  async get(
    user: AuthenticatedUser,
    projectId: string,
    auditLogId: string,
  ): Promise<AuditLogResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    const row = await this.prisma.client.auditLog.findFirst({
      where: { id: auditLogId, projectId },
    });
    if (!row) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Audit log entry not found in this project',
      });
    }
    return this.toResponse(row);
  }

  private toResponse(row: AuditLog): AuditLogResponseDto {
    return {
      id: row.id,
      projectId: row.projectId,
      actorId: row.actorId,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      operationId: row.operationId,
      requestId: row.requestId,
      previousData: row.previousData as Record<string, unknown> | null,
      newData: row.newData as Record<string, unknown>,
      createdAt: row.createdAt,
    };
  }
}
