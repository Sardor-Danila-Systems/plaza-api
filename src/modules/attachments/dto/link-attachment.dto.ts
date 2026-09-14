import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsUUID } from 'class-validator';
import { AttachmentTarget } from '../attachment-target.enum.js';

export class LinkAttachmentDto {
  @ApiProperty({ enum: AttachmentTarget })
  @IsEnum(AttachmentTarget)
  target!: AttachmentTarget;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  targetId!: string;
}
