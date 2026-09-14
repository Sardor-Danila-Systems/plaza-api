import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ErrorResponseDto } from '../../../common/dto/error-response.dto.js';
import { IdempotencyKey } from '../../../common/decorators/idempotency-key.decorator.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { DebtPaymentsService } from './debt-payments.service.js';
import { CreateDebtPaymentDto } from './dto/create-debt-payment.dto.js';
import { SettlementAllocationResponseDto } from './dto/settlement-allocation-response.dto.js';

@ApiTags('suppliers')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/suppliers/:supplierId/debt-payments')
export class DebtPaymentsController {
  constructor(private readonly debtPaymentsService: DebtPaymentsService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: "Pay down a purchase's debt",
    description: 'PROJECT_MANAGER of this project only.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: SettlementAllocationResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    description:
      'INSUFFICIENT_CASH | SETTLEMENT_RATE_REQUIRED | DEBT_PAYMENT_EXCEEDS_REMAINING | PURCHASE_ALREADY_CANCELLED | IDEMPOTENCY_KEY_REUSED | CONCURRENT_MODIFICATION',
    type: ErrorResponseDto,
  })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('supplierId', ParseUUIDPipe) supplierId: string,
    @Body() dto: CreateDebtPaymentDto,
    @IdempotencyKey() idempotencyKey: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SettlementAllocationResponseDto> {
    const result = await this.debtPaymentsService.create(
      user,
      projectId,
      supplierId,
      dto,
      idempotencyKey,
      req.id,
    );
    if (result.isReplay) {
      res.status(200);
    }
    return result.allocation;
  }
}
