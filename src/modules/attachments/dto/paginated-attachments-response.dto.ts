import { ApiProperty } from '@nestjs/swagger';
import { AttachmentResponseDto } from './attachment-response.dto.js';

export class PaginatedAttachmentsResponseDto {
  @ApiProperty({ type: [AttachmentResponseDto] })
  data!: AttachmentResponseDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
