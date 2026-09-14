import { ApiProperty } from '@nestjs/swagger';
import { AuditLogResponseDto } from './audit-log-response.dto.js';

export class PaginatedAuditResponseDto {
  @ApiProperty({ type: [AuditLogResponseDto] })
  data!: AuditLogResponseDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
