import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../../../common/dto/error-response.dto.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { InventoryBalanceResponseDto } from './dto/inventory-balance-response.dto.js';
import { ListInventoryQueryDto } from './dto/list-inventory-query.dto.js';
import { InventoryBalancesService } from './inventory-balances.service.js';

@ApiTags('inventory')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/inventory')
export class InventoryBalancesController {
  constructor(private readonly balancesService: InventoryBalancesService) {}

  @Get()
  @ApiOperation({ summary: 'Current inventory balances for a project' })
  @ApiOkResponse({ type: [InventoryBalanceResponseDto] })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: ListInventoryQueryDto,
  ): Promise<InventoryBalanceResponseDto[]> {
    return this.balancesService.list(user, projectId, query);
  }
}
