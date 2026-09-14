import { ApiProperty } from '@nestjs/swagger';

export class HealthResponseDto {
  @ApiProperty({ example: 'ok' })
  status!: 'ok';

  @ApiProperty({ example: 'up' })
  database!: 'up';

  @ApiProperty({ example: '2026-09-13T12:00:00.000Z' })
  timestamp!: string;
}
