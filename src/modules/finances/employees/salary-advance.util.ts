import { BadRequestException, ConflictException } from '@nestjs/common';
import { Currency, Prisma } from '../../../generated/prisma/client.js';
import type { PrismaTx } from '../../../database/project-lock.service.js';

export interface OpenAdvance {
  id: string;
  occurredAt: Date;
  currency: Currency;
  amount: Prisma.Decimal;
  deducted: Prisma.Decimal;
  remaining: Prisma.Decimal;
}

const ZERO = new Prisma.Decimal(0);

/** Deducted amounts per advance, ignoring payouts that were cancelled — so
 * cancelling a salary payout releases its advances without any bookkeeping. */
export async function deductedByAdvance(
  tx: PrismaTx,
  projectId: string,
  advanceIds: string[],
): Promise<Map<string, Prisma.Decimal>> {
  const map = new Map<string, Prisma.Decimal>();
  if (advanceIds.length === 0) return map;
  const rows = await tx.advanceDeduction.groupBy({
    by: ['advanceId'],
    where: {
      projectId,
      advanceId: { in: advanceIds },
      payout: { cancelledAt: null },
    },
    _sum: { amount: true },
  });
  for (const r of rows) map.set(r.advanceId, r._sum.amount ?? ZERO);
  return map;
}

/** Live (not cancelled, not a reversal row) advances of one employee, with
 * what is still not deducted. Oldest first. */
export async function listAdvances(
  tx: PrismaTx,
  projectId: string,
  employeeId: string,
): Promise<OpenAdvance[]> {
  const advances = await tx.financialTransaction.findMany({
    where: {
      projectId,
      employeeId,
      isAdvance: true,
      reversalOfId: null,
      cancelledAt: null,
    },
    orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
  });
  const deducted = await deductedByAdvance(
    tx,
    projectId,
    advances.map((a) => a.id),
  );
  return advances.map((a) => {
    const d = deducted.get(a.id) ?? ZERO;
    return {
      id: a.id,
      occurredAt: a.occurredAt,
      currency: a.currency,
      amount: a.amount,
      deducted: d,
      remaining: a.amount.sub(d),
    };
  });
}

export interface DeductionInput {
  advanceId: string;
  amount: string;
}

export interface PreparedPayout {
  accruedAmount: Prisma.Decimal | null;
  deductions: { advanceId: string; amount: Prisma.Decimal }[];
}

function invalid(message: string): never {
  throw new BadRequestException({ code: 'VALIDATION_ERROR', message });
}

/**
 * Validates a salary payout against the employee's open advances.
 * accrued ("начислено") must equal cash paid ("к выдаче") + deductions.
 * Zero cash is allowed only when advances cover the whole salary.
 */
export async function prepareSalaryPayout(
  tx: PrismaTx,
  projectId: string,
  employeeId: string,
  currency: Currency,
  amount: Prisma.Decimal,
  accruedInput: string | undefined,
  deductionInputs: DeductionInput[] | undefined,
): Promise<PreparedPayout> {
  const inputs = deductionInputs ?? [];
  if (inputs.length === 0) {
    if (amount.lte(0)) invalid('amount must be greater than zero');
    if (accruedInput !== undefined) {
      const accrued = new Prisma.Decimal(accruedInput);
      if (!accrued.eq(amount)) {
        invalid('accruedAmount must equal amount when nothing is deducted');
      }
    }
    return { accruedAmount: null, deductions: [] };
  }

  if (accruedInput === undefined) {
    invalid('accruedAmount is required when advances are deducted');
  }
  const accrued = new Prisma.Decimal(accruedInput);
  const seen = new Set<string>();
  const advances = new Map(
    (await listAdvances(tx, projectId, employeeId)).map((a) => [a.id, a]),
  );
  let total = ZERO;
  const deductions: PreparedPayout['deductions'] = [];
  for (const input of inputs) {
    if (seen.has(input.advanceId)) {
      invalid('the same advance is listed twice in deductions');
    }
    seen.add(input.advanceId);
    const advance = advances.get(input.advanceId);
    if (!advance) {
      invalid('advance not found for this employee, or it is cancelled');
    }
    if (advance.currency !== currency) {
      invalid('an advance can only be deducted in its own currency');
    }
    const value = new Prisma.Decimal(input.amount);
    if (value.lte(0)) invalid('deduction amount must be greater than zero');
    if (value.gt(advance.remaining)) {
      throw new ConflictException({
        code: 'DEDUCTION_EXCEEDS_ADVANCE',
        message: 'Deduction is larger than the unspent part of the advance',
      });
    }
    total = total.add(value);
    deductions.push({ advanceId: input.advanceId, amount: value });
  }
  if (!accrued.eq(amount.add(total))) {
    invalid('accruedAmount must equal amount (к выдаче) + deducted advances');
  }
  return { accruedAmount: accrued, deductions };
}

/** An advance that has been (even partly) deducted from a live payout can
 * only be cancelled after that payout is cancelled. */
export async function assertAdvanceNotDeducted(
  tx: PrismaTx,
  projectId: string,
  advanceId: string,
): Promise<void> {
  const used = await tx.advanceDeduction.findFirst({
    where: { projectId, advanceId, payout: { cancelledAt: null } },
    select: { id: true },
  });
  if (used) {
    throw new ConflictException({
      code: 'ADVANCE_ALREADY_DEDUCTED',
      message:
        'This advance is already deducted from a salary; cancel that salary payout first',
    });
  }
}
