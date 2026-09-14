import { Currency, Prisma } from '../../generated/prisma/client.js';
import { round2 } from '../money/decimal.util.js';

/** Thrown when transaction-design.md §5's case 3 applies (settlement and
 * debt currencies differ, and the debt currency is not UZS) but no explicit
 * `settlementExchangeRate` was supplied — the caller translates this into
 * `409 SETTLEMENT_RATE_REQUIRED`. A plain error, not a NestJS exception,
 * matching `InsufficientStockError`'s separation of pure logic from HTTP
 * concerns (`src/common/inventory/costing.util.ts`). */
export class SettlementRateRequiredError extends Error {
  constructor() {
    super(
      'An explicit settlementExchangeRate is required for this cross-currency settlement',
    );
    this.name = 'SettlementRateRequiredError';
  }
}

export interface SettlementCaseResult {
  debtAmountSettled: Prisma.Decimal;
  settlementExchangeRate: Prisma.Decimal | null;
}

/**
 * transaction-design.md §5's three-case cross-currency settlement formula —
 * the exact "how" for turning one payment/advance allocation (in its own
 * `settlementCurrency`) into `debtAmountSettled` (in the purchase's own
 * `debtCurrency`). The discriminator is entirely the two currencies
 * involved, never caller choice. Shared by `DebtPaymentsService` and
 * `PurchasesService` so both use byte-identical arithmetic.
 */
export function resolveSettlementCase(params: {
  settlementCurrency: Currency;
  settlementAmount: Prisma.Decimal;
  settlementValueUzs: Prisma.Decimal;
  debtCurrency: Currency;
  providedSettlementExchangeRate?: Prisma.Decimal;
}): SettlementCaseResult {
  const {
    settlementCurrency,
    settlementAmount,
    settlementValueUzs,
    debtCurrency,
    providedSettlementExchangeRate,
  } = params;

  if (settlementCurrency === debtCurrency) {
    // Case 1: no conversion, no rate field used at all.
    return {
      debtAmountSettled: settlementAmount,
      settlementExchangeRate: null,
    };
  }

  if (debtCurrency === Currency.UZS) {
    // Case 2: uses the settlement's own already-required rate.
    return {
      debtAmountSettled: settlementValueUzs,
      settlementExchangeRate: null,
    };
  }

  // Case 3: requires a new, explicit, positive rate for this allocation.
  if (
    providedSettlementExchangeRate === undefined ||
    !providedSettlementExchangeRate.greaterThan(0)
  ) {
    throw new SettlementRateRequiredError();
  }
  return {
    debtAmountSettled: round2(
      settlementValueUzs.dividedBy(providedSettlementExchangeRate),
    ),
    settlementExchangeRate: providedSettlementExchangeRate,
  };
}

/**
 * The informational-only exchange-difference figure (transaction-design.md
 * §5) — never affects debt or cash arithmetic. `purchaseExchangeRateAtInvoice`
 * is `1` when `debtCurrency = 'UZS'`.
 */
export function computeExchangeDifferenceUzs(
  settlementValueUzs: Prisma.Decimal,
  debtAmountSettled: Prisma.Decimal,
  purchaseExchangeRateAtInvoice: Prisma.Decimal,
): Prisma.Decimal {
  return settlementValueUzs.minus(
    round2(debtAmountSettled.mul(purchaseExchangeRateAtInvoice)),
  );
}
