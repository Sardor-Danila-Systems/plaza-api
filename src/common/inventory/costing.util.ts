import { Prisma } from '../../generated/prisma/client.js';
import { roundHalfUp } from '../money/decimal.util.js';

/** Inventory carrying values retain 8 decimal places
 * (docs/backend-architecture.md §4: "Inventory carrying value and unit cost
 * snapshot | Decimal(30,8) | Retain 8 decimal places for moving-cost
 * operations") — deliberately more precise than money's 2dp, so repeated
 * weighted-average operations don't compound rounding error. */
const CARRYING_VALUE_SCALE = 8;

export function roundCarryingValue(value: Prisma.Decimal): Prisma.Decimal {
  return roundHalfUp(value, CARRYING_VALUE_SCALE);
}

/** A warehouse/material's current stock position — exactly the two columns
 * `InventoryBalance` persists (`quantity`, `valueUzs`). There is
 * deliberately no `averageCostUzs` field anywhere in this module:
 * docs/backend-data-model.md is explicit that the average is always
 * *derived*, never an independently stored/mutable column. */
export interface StockPosition {
  quantity: Prisma.Decimal;
  valueUzs: Prisma.Decimal;
}

/**
 * The weighted-average unit cost implied by a stock position — always
 * `valueUzs / quantity`, and always exactly `0` when `quantity` is `0`
 * (docs/backend-architecture.md §2's zero-quantity invariant; never a
 * division by zero). This is the only place "average cost" is computed
 * anywhere in this system; nothing stores it.
 */
export function averageCostUzs(position: StockPosition): Prisma.Decimal {
  if (position.quantity.isZero()) {
    return new Prisma.Decimal(0);
  }
  return position.valueUzs.dividedBy(position.quantity);
}

/**
 * A receipt (inbound movement: opening stock, a future purchase receipt,
 * or a transfer-in). Per docs/backend-architecture.md §4: "For a receipt,
 * with existing quantity Q, value V, received quantity q, and posted
 * receipt value v, store Q' = Q + q, V' = V + v; display average V'/Q'."
 * Value is strictly additive — there is no "weighted average" arithmetic to
 * perform here at all; the average is only ever a read-time ratio (see
 * `averageCostUzs`). `incomingQuantity`/`incomingUnitCostUzs` must already
 * be positive; this function does not itself validate that (the CHECK
 * constraints on `StockMovement` do, once a caller exists).
 */
export function receiveStock(
  current: StockPosition,
  incomingQuantity: Prisma.Decimal,
  incomingUnitCostUzs: Prisma.Decimal,
): { result: StockPosition; totalCostUzs: Prisma.Decimal } {
  const totalCostUzs = roundCarryingValue(
    incomingQuantity.mul(incomingUnitCostUzs),
  );
  return {
    result: {
      quantity: current.quantity.plus(incomingQuantity),
      valueUzs: current.valueUzs.plus(totalCostUzs),
    },
    totalCostUzs,
  };
}

/** Thrown by `depleteStock` when the requested outgoing quantity exceeds
 * what is on hand — a plain, framework-agnostic error (no NestJS
 * dependency here, matching this module's status as a pure utility); the
 * future write-off/transfer service that calls this translates it into
 * `409 INSUFFICIENT_STOCK`, the same separation `FinancialPostingService`
 * keeps from `src/common/money/decimal.util.ts`. */
export class InsufficientStockError extends Error {
  constructor(
    public readonly available: Prisma.Decimal,
    public readonly requested: Prisma.Decimal,
  ) {
    super(
      `Insufficient stock: available ${available.toString()}, requested ${requested.toString()}`,
    );
    this.name = 'InsufficientStockError';
  }
}

/**
 * An outbound movement (write-off, transfer-out, or a future consumption
 * workflow). Values the departing quantity at the CURRENT weighted-average
 * cost, computed once up front — never recomputed mid-calculation.
 *
 * The full-depletion case (`outgoingQuantity === current.quantity`) is
 * hardcoded to land on exactly zero rather than trusting subtraction to
 * get there (docs/backend-architecture.md §2 / this phase's §13): floating
 * subtraction of two numbers that are mathematically equal is exact in
 * `Decimal` too, but the *value* side (`valueUzs - totalCostUzs`) is not
 * guaranteed to net to precisely zero when `totalCostUzs` was itself
 * rounded to 8dp during this same call — hardcoding avoids ever depending
 * on that coincidence.
 */
export function depleteStock(
  current: StockPosition,
  outgoingQuantity: Prisma.Decimal,
): {
  result: StockPosition;
  unitCostUzs: Prisma.Decimal;
  totalCostUzs: Prisma.Decimal;
} {
  if (outgoingQuantity.greaterThan(current.quantity)) {
    throw new InsufficientStockError(current.quantity, outgoingQuantity);
  }

  const unitCostUzs = averageCostUzs(current);

  if (outgoingQuantity.equals(current.quantity)) {
    return {
      result: { quantity: new Prisma.Decimal(0), valueUzs: new Prisma.Decimal(0) },
      unitCostUzs,
      // The entire remaining carrying value departs with the last unit,
      // not `outgoingQuantity * unitCostUzs` (which could differ from
      // `current.valueUzs` by a fraction of a unit due to the division
      // above) — see the full-depletion note.
      totalCostUzs: current.valueUzs,
    };
  }

  const totalCostUzs = roundCarryingValue(outgoingQuantity.mul(unitCostUzs));
  return {
    result: {
      quantity: current.quantity.minus(outgoingQuantity),
      valueUzs: current.valueUzs.minus(totalCostUzs),
    },
    unitCostUzs,
    totalCostUzs,
  };
}
