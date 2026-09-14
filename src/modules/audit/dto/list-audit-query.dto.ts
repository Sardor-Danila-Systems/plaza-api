import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { IsBusinessDate } from '../../../common/validators/is-business-date.validator.js';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * `GET P/audit` filters (Phase 9, deferred exactly this far by ADR 0016).
 * `dateFrom`/`dateTo` bound `AuditLog.createdAt` — a real wall-clock
 * timestamp, not a business-dated ledger field — so, unlike
 * `occurredAt` filters elsewhere, these are plain UTC day boundaries with
 * no project-timezone business-date treatment.
 */
export class ListAuditQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @ApiPropertyOptional({ example: 'purchase.create' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  action?: string;

  @ApiPropertyOptional({ example: 'Purchase' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  entityType?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  entityId?: string;

  @ApiPropertyOptional({
    example: '2026-09-01',
    description: 'Inclusive lower bound on createdAt (UTC calendar date).',
  })
  @IsOptional()
  @IsBusinessDate()
  dateFrom?: string;

  @ApiPropertyOptional({
    example: '2026-09-30',
    description: 'Exclusive upper bound on createdAt (UTC calendar date).',
  })
  @IsOptional()
  @IsBusinessDate()
  dateTo?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    default: DEFAULT_PAGE_SIZE,
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize: number = DEFAULT_PAGE_SIZE;
}
