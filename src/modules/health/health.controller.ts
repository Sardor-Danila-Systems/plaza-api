import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PrismaService } from '../../database/prisma.service.js';
import { ErrorResponseDto } from '../../common/dto/error-response.dto.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { HealthResponseDto } from './dto/health-response.dto.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  // Infra/monitoring probes — must stay reachable without a valid session
  // (there usually isn't one), unlike every business route added from here on.

  /**
   * Liveness only: answers without touching the database. A hosting health
   * check polls this every few seconds, and a query per poll would keep a
   * scale-to-zero database (Neon) awake around the clock — that is exactly
   * what ran the compute up to 24/7. Point the platform's health check here.
   */
  @Public()
  @Get()
  @ApiOperation({
    summary: 'Liveness check (no authentication, never queries the database)',
  })
  @ApiOkResponse({ type: HealthResponseDto })
  live(): HealthResponseDto {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /** Liveness plus database connectivity. Run it by hand after a deploy;
   * do not poll it on a schedule (see `live`). */
  @Public()
  @Get('db')
  @ApiOperation({
    summary:
      'Liveness and database connectivity check (no authentication required)',
  })
  @ApiOkResponse({ type: HealthResponseDto })
  @ApiServiceUnavailableResponse({
    description: 'Database is unreachable',
    type: ErrorResponseDto,
  })
  async checkDatabase(): Promise<HealthResponseDto> {
    try {
      await this.prisma.client.$queryRaw`SELECT 1`;
    } catch {
      // The underlying driver error (host, port, credentials) is never
      // surfaced to the client — see docs/backend-architecture.md §9. It is
      // still visible server-side because AllExceptionsFilter logs every 5xx.
      throw new ServiceUnavailableException({
        code: 'DATABASE_UNAVAILABLE',
        message: 'Database connection failed',
      });
    }

    return {
      status: 'ok',
      database: 'up',
      timestamp: new Date().toISOString(),
    };
  }
}
