import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class HealthResponseDto {
  @ApiProperty({ example: 'ok' })
  status!: 'ok';

  @ApiPropertyOptional({
    example: 'up',
    description: 'Only reported by GET /health/db',
  })
  database?: 'up';

  @ApiProperty({ example: '2026-09-13T12:00:00.000Z' })
  timestamp!: string;
}
