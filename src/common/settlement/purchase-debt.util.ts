import { PrismaTx } from '../../database/project-lock.service.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma, SettlementEffect } from '../../generated/prisma/client.js';

/**
 * The purchase's remaining debt, in its own currency
 * (docs/backend-data-model.md: "there is no `Supplier.debt` scalar...
 * Current debt is the purchase's `totalAmount` less the sum of effective
 * `debtAmountSettled` values"). "Effective" means APPLY rows minus REVERSE
 * rows — a settlement's own `effect` column encodes cancellation, the same
 * way `FinancialTransaction`'s reversal rows do via direction instead.
 */
export async function computeRemainingDebt(
  client: PrismaTx | PrismaService['client'],
  purchaseId: string,
  totalAmount: Prisma.Decimal,
): Promise<Prisma.Decimal> {
  const grouped = await client.settlementAllocation.groupBy({
    by: ['effect'],
    where: { purchaseId },
    _sum: { debtAmountSettled: true },
  });
  let applied = new Prisma.Decimal(0);
  let reversed = new Prisma.Decimal(0);
  for (const row of grouped) {
    if (row.effect === SettlementEffect.APPLY) {
      applied = row._sum.debtAmountSettled ?? applied;
    } else {
      reversed = row._sum.debtAmountSettled ?? reversed;
    }
  }
  return totalAmount.minus(applied).plus(reversed);
}
