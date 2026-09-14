import { Prisma } from '../../generated/prisma/client.js';
import { round2 } from './decimal.util.js';

/**
 * Distributes `total` (already computed, e.g. an invoice's UZS total)
 * across `weights` (e.g. each line's own-currency amount) proportionally,
 * using the largest-remainder method so the distributed amounts sum
 * EXACTLY to `total` — never off by a cent due to independent per-line
 * rounding (docs/backend-architecture.md §4: "Distribute the converted
 * value among lines using the largest fractional remainders: truncate each
 * exact converted line to 2 places, then assign remaining 0.01 increments
 * by descending fractional remainder, ties by stable line number").
 *
 * Returns one Decimal per input weight, in the same order, at 2 decimal
 * places, summing exactly to `total`.
 */
export function distributeLargestRemainder(
  weights: Prisma.Decimal[],
  total: Prisma.Decimal,
): Prisma.Decimal[] {
  if (weights.length === 0) {
    return [];
  }
  const weightSum = weights.reduce(
    (sum, w) => sum.plus(w),
    new Prisma.Decimal(0),
  );
  if (weightSum.isZero()) {
    // No meaningful proportion to distribute by; every weight is zero.
    // Not expected in practice (line amounts are always positive), but
    // avoids a division by zero rather than assuming the caller never hits
    // it.
    return weights.map(() => new Prisma.Decimal(0));
  }

  const exact = weights.map((w) => total.mul(w).dividedBy(weightSum));
  const truncated = exact.map((e) =>
    e.toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN),
  );
  const truncatedSum = truncated.reduce(
    (sum, t) => sum.plus(t),
    new Prisma.Decimal(0),
  );
  const remainderCents = round2(total.minus(truncatedSum))
    .mul(100)
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
    .toNumber();

  const remainders = exact.map((e, index) => ({
    index,
    remainder: e.minus(truncated[index]),
  }));
  // Largest fractional remainder first; ties broken by stable line index
  // (Array.prototype.sort is stable per the ECMAScript spec, and the
  // original index is carried explicitly as a tiebreaker regardless).
  remainders.sort((a, b) => {
    const cmp = b.remainder.comparedTo(a.remainder);
    return cmp !== 0 ? cmp : a.index - b.index;
  });

  const result = [...truncated];
  for (let i = 0; i < remainderCents; i += 1) {
    const { index } = remainders[i % remainders.length];
    result[index] = result[index].plus('0.01');
  }
  return result;
}
