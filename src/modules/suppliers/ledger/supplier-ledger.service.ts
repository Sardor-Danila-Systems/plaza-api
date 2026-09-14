import { Injectable, NotFoundException } from '@nestjs/common';
import { computeRemainingDebt } from '../../../common/settlement/purchase-debt.util.js';
import { PrismaService } from '../../../database/prisma.service.js';
import {
  Currency,
  Prisma,
  SettlementEffect,
} from '../../../generated/prisma/client.js';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { ProjectAccessAction } from '../../projects/project-access-action.enum.js';
import { ProjectAccessService } from '../../projects/project-access.service.js';
import { SupplierLedgerResponseDto } from './dto/supplier-ledger-response.dto.js';

@Injectable()
export class SupplierLedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  async get(
    user: AuthenticatedUser,
    projectId: string,
    supplierId: string,
  ): Promise<SupplierLedgerResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );

    const supplier = await this.prisma.client.supplier.findFirst({
      where: { id: supplierId, projectId },
    });
    if (!supplier) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Supplier not found in this project',
      });
    }

    const purchases = await this.prisma.client.purchase.findMany({
      where: { supplierId, projectId },
      orderBy: { occurredAt: 'desc' },
    });

    const debtByCurrency = new Map<Currency, Prisma.Decimal>();
    const purchaseSummaries = [];
    for (const purchase of purchases) {
      const remaining = purchase.cancelledAt
        ? new Prisma.Decimal(0)
        : await computeRemainingDebt(
            this.prisma.client,
            purchase.id,
            purchase.totalAmount,
          );
      if (!purchase.cancelledAt && remaining.greaterThan(0)) {
        debtByCurrency.set(
          purchase.currency,
          (debtByCurrency.get(purchase.currency) ?? new Prisma.Decimal(0)).plus(
            remaining,
          ),
        );
      }
      purchaseSummaries.push({
        id: purchase.id,
        currency: purchase.currency,
        totalAmount: purchase.totalAmount.toFixed(2),
        remainingDebt: remaining.toFixed(2),
        cancelled: purchase.cancelledAt !== null,
        occurredAt: purchase.occurredAt.toISOString().slice(0, 10),
      });
    }

    const advances = await this.prisma.client.supplierAdvance.findMany({
      where: { supplierId, projectId },
    });
    const advanceByCurrency = new Map<Currency, Prisma.Decimal>();
    for (const advance of advances) {
      const grouped = await this.prisma.client.settlementAllocation.groupBy({
        by: ['effect'],
        where: { advanceId: advance.id },
        _sum: { settlementAmount: true },
      });
      let applied = new Prisma.Decimal(0);
      let reversed = new Prisma.Decimal(0);
      for (const row of grouped) {
        if (row.effect === SettlementEffect.APPLY) {
          applied = row._sum.settlementAmount ?? applied;
        } else {
          reversed = row._sum.settlementAmount ?? reversed;
        }
      }
      const available = advance.fundedAmount.minus(applied).plus(reversed);
      advanceByCurrency.set(
        advance.currency,
        (advanceByCurrency.get(advance.currency) ?? new Prisma.Decimal(0)).plus(
          available,
        ),
      );
    }

    return {
      supplierId,
      outstandingDebt: [...debtByCurrency.entries()].map(
        ([currency, amount]) => ({
          currency,
          amount: amount.toFixed(2),
        }),
      ),
      availableAdvance: [...advanceByCurrency.entries()].map(
        ([currency, amount]) => ({
          currency,
          amount: amount.toFixed(2),
        }),
      ),
      purchases: purchaseSummaries,
    };
  }
}
