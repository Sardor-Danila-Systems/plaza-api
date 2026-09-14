import { ApiProperty } from '@nestjs/swagger';
import { AttachmentStatus } from '../../../generated/prisma/client.js';
import { AttachmentTarget } from '../attachment-target.enum.js';

export class AttachmentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  projectId!: string;

  @ApiProperty({ enum: AttachmentStatus })
  status!: AttachmentStatus;

  @ApiProperty()
  originalFilename!: string;

  @ApiProperty()
  mimeType!: string;

  @ApiProperty()
  sizeBytes!: number;

  @ApiProperty({ format: 'uuid' })
  uploadedById!: string;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({ nullable: true })
  readyAt!: Date | null;

  @ApiProperty({ nullable: true })
  linkedAt!: Date | null;

  @ApiProperty({ nullable: true })
  failedAt!: Date | null;

  @ApiProperty({ nullable: true })
  failureReason!: string | null;

  @ApiProperty({ enum: AttachmentTarget, nullable: true })
  target!: AttachmentTarget | null;

  @ApiProperty({ format: 'uuid', nullable: true })
  targetId!: string | null;
}
