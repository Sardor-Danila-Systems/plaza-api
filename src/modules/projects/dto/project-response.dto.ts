import { ApiProperty } from '@nestjs/swagger';
import { ManagerSummaryDto } from './manager-summary.dto.js';

export class ProjectResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty({ example: 'Asia/Samarkand' })
  timezone!: string;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty({ type: ManagerSummaryDto, nullable: true })
  manager!: ManagerSummaryDto | null;

  @ApiProperty()
  createdAt!: Date;
}
