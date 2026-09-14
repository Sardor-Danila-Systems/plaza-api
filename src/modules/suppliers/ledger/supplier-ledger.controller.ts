import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../../../common/dto/error-response.dto.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { SupplierLedgerResponseDto } from './dto/supplier-ledger-response.dto.js';
import { SupplierLedgerService } from './supplier-ledger.service.js';

@ApiTags('suppliers')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/suppliers/:supplierId/ledger')
export class SupplierLedgerController {
  constructor(private readonly ledgerService: SupplierLedgerService) {}

  @Get()
  @ApiOperation({ summary: "A supplier's derived debt/advance ledger" })
  @ApiOkResponse({ type: SupplierLedgerResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('supplierId', ParseUUIDPipe) supplierId: string,
  ): Promise<SupplierLedgerResponseDto> {
    return this.ledgerService.get(user, projectId, supplierId);
  }
}
