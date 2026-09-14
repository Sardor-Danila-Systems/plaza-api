import { ApiProperty } from '@nestjs/swagger';

export class AuditLogResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  projectId!: string;

  @ApiProperty({ format: 'uuid' })
  actorId!: string;

  @ApiProperty({ example: 'purchase.create' })
  action!: string;

  @ApiProperty({ example: 'Purchase' })
  entityType!: string;

  @ApiProperty({ format: 'uuid' })
  entityId!: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  operationId!: string | null;

  @ApiProperty({ nullable: true })
  requestId!: string | null;

  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  previousData!: Record<string, unknown> | null;

  @ApiProperty({ type: 'object', additionalProperties: true })
  newData!: Record<string, unknown>;

  @ApiProperty()
  createdAt!: Date;
}
