import { Prisma } from '../../generated/prisma/client.js';

/**
 * The single rounding rule for every calculated Decimal in this system,
 * parameterized by scale (docs/backend-architecture.md §4: "Round
 * calculated amounts half-up at explicit boundaries") — money rounds to 2
 * places, inventory carrying values to 8 (see `src/common/inventory/
 * costing.util.ts`). Never used to re-round a value that is itself already
 * a stored, posted amount (reversals/history copy stored values verbatim).
 */
export function roundHalfUp(
  value: Prisma.Decimal,
  decimalPlaces: number,
): Prisma.Decimal {
  return value.toDecimalPlaces(decimalPlaces, Prisma.Decimal.ROUND_HALF_UP);
}

/** `roundHalfUp(value, 2)` — money's own scale. */
export function round2(value: Prisma.Decimal): Prisma.Decimal {
  return roundHalfUp(value, 2);
}

/**
 * `amountUzs` for a posted financial row, per docs/backend-architecture.md
 * §4: "For UZS, exchangeRate = 1 and amountUzs = amount. For USD,
 * amountUzs = round2(amount * exchangeRate)." Written as one formula (rather
 * than a UZS/USD branch) because it is already exactly correct for UZS once
 * `exchangeRate` is the server-set constant `1` — multiplying by 1 and
 * rounding a value that is already at 2dp is a no-op.
 */
export function computeAmountUzs(
  amount: Prisma.Decimal,
  exchangeRate: Prisma.Decimal,
): Prisma.Decimal {
  return round2(amount.mul(exchangeRate));
}
