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

  // Infra/monitoring probe — must stay reachable without a valid session
  // (there usually isn't one), unlike every business route added from here on.
  @Public()
  @Get()
  @ApiOperation({
    summary:
      'Liveness and database connectivity check (no authentication required)',
  })
  @ApiOkResponse({ type: HealthResponseDto })
  @ApiServiceUnavailableResponse({
    description: 'Database is unreachable',
    type: ErrorResponseDto,
  })
  async check(): Promise<HealthResponseDto> {
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
