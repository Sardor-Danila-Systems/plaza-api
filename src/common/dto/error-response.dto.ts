import { ApiProperty } from '@nestjs/swagger';

/**
 * The stable error response shape every endpoint in this application returns.
 * Later phases add business error `code`s (e.g. `PROJECT_ACCESS_DENIED`,
 * `INSUFFICIENT_STOCK` — see docs/transaction-design.md §10) by throwing a
 * Nest `HttpException` with `{ code, message }` as its response body; they
 * never need their own filter or response shape.
 */
export class ErrorResponseDto {
  @ApiProperty({ example: 400, description: 'HTTP status code' })
  statusCode!: number;

  @ApiProperty({
    example: 'Bad Request',
    description: 'HTTP status reason phrase',
  })
  error!: string;

  @ApiProperty({
    example: 'VALIDATION_ERROR',
    description: 'Stable machine-readable business/technical error code',
  })
  code!: string;

  @ApiProperty({
    description: 'Human-readable message, or list of validation failures',
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
  })
  message!: string | string[];

  @ApiProperty({
    example: '/api/v1/projects',
    description: 'Request path that failed',
  })
  path!: string;

  @ApiProperty({
    example: '2026-09-13T12:00:00.000Z',
    description: 'Server time (ISO 8601)',
  })
  timestamp!: string;

  @ApiProperty({
    example: 'a1b2c3d4-...',
    description: 'Correlates this error with server logs and the audit trail',
  })
  requestId!: string;
}
