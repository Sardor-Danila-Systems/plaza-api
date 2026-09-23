import { Injectable } from '@nestjs/common';
import { PrismaTx } from '../../database/project-lock.service.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  Currency,
  FinancialTransactionType,
  Prisma,
  SettlementEffect,
  StockMovementType,
  TransactionDirection,
} from '../../generated/prisma/client.js';
import { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { ProjectAccessAction } from '../projects/project-access-action.enum.js';
import { ProjectAccessService } from '../projects/project-access.service.js';
import {
  AnalyticsSummaryResponseDto,
  CashFlowDto,
  CurrencyAmountDto,
} from './dto/analytics-summary-response.dto.js';
import { AnalyticsPeriodQueryDto } from './dto/analytics-period-query.dto.js';
import { ConstructionAnalyticsQueryDto } from './dto/construction-analytics-query.dto.js';
import { ConstructionAnalyticsResponseDto } from './dto/construction-analytics-response.dto.js';
import { MaterialsAnalyticsQueryDto } from './dto/materials-analytics-query.dto.js';
import { MaterialsAnalyticsResponseDto } from './dto/material-analytics-response.dto.js';

const ZERO = new Prisma.Decimal(0);

function toDate(businessDate: string | undefined): Date | undefined {
  return businessDate ? new Date(`${businessDate}T00:00:00.000Z`) : undefined;
}

/**
 * `[from, to)` window builders for a `DateTime` column — the same
 * convention `ListFinancialTransactionsQueryDto` etc. already use
 * (docs/backend-architecture.md §11: "Flow metrics use `occurredOn` in
 * `[from,to)`").
 */
function windowFilter(
  from: Date | undefined,
  to: Date | undefined,
): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  return { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) };
}

/**
 * All aggregation for one authorized project (docs/backend-architecture.md
 * §11). Every metric here reads directly from the authoritative ledger/
 * projection tables Phases 4-8 already built — there is no second,
 * independently-mutable "Analytics" table anywhere in this schema.
 * Historical figures (supplier debt/advance "as of `to`", inventory value
 * "as of `to`") are RECONSTRUCTED from dated postings each time, never
 * read from a live mutable balance — see each private helper's own doc
 * comment for the exact reconstruction.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  async getSummary(
    user: AuthenticatedUser,
    projectId: string,
    query: AnalyticsPeriodQueryDto,
  ): Promise<AnalyticsSummaryResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    const from = toDate(query.dateFrom);
    const to = toDate(query.dateTo);

    // One consistent read-only snapshot for the whole multi-metric
    // dashboard (docs/backend-architecture.md §11: "Take a consistent
    // read-only transaction snapshot for a multi-metric dashboard or
    // export") — RepeatableRead is enough for a pure-read snapshot; this
    // never writes, so it carries none of the Serializable-retry protocol's
    // concerns (this is not a mutating business workflow).
    return this.prisma.client.$transaction(
      async (tx) => {
        const project = await tx.project.findUniqueOrThrow({
          where: { id: projectId },
          select: { postingSequence: true },
        });

        const [cashUzs, cashUsd] = await Promise.all([
          this.cashFlow(tx, projectId, Currency.UZS, from, to),
          this.cashFlow(tx, projectId, Currency.USD, from, to),
        ]);

        const expensesByCategory = await this.expensesByCategory(
          tx,
          projectId,
          from,
          to,
        );
        const salariesUzs = await this.sumFinancialAmountUzs(
          tx,
          projectId,
          FinancialTransactionType.SALARY,
          from,
          to,
        );
        const { totalUzs: purchasesTotalUzs, count: purchasesCount } =
          await this.purchaseVolume(tx, projectId, from, to);

        const supplierDebtAsOf = await this.supplierDebtAsOf(tx, projectId, to);
        const supplierAdvancesAvailableAsOf =
          await this.supplierAdvancesAvailableAsOf(tx, projectId, to);
        const currentInventoryValueUzs = await this.currentInventoryValue(
          tx,
          projectId,
        );
        const inventoryValueAsOfUzs = await this.inventoryValueAsOf(
          tx,
          projectId,
          to,
        );

        return {
          projectId,
          dateFrom: query.dateFrom ?? null,
          dateTo: query.dateTo ?? null,
          generatedAt: new Date().toISOString(),
          postingSequenceCutoff: project.postingSequence.toString(),
          cashUzs,
          cashUsd,
          expensesByCategory,
          salariesUzs: salariesUzs.toFixed(2),
          purchasesTotalUzs: purchasesTotalUzs.toFixed(2),
          purchasesCount,
          supplierDebtAsOf,
          supplierAdvancesAvailableAsOf,
          currentInventoryValueUzs: currentInventoryValueUzs.toFixed(8),
          inventoryValueAsOfUzs: inventoryValueAsOfUzs.toFixed(8),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async getMaterials(
    user: AuthenticatedUser,
    projectId: string,
    query: MaterialsAnalyticsQueryDto,
  ): Promise<MaterialsAnalyticsResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    const from = toDate(query.dateFrom);
    const to = toDate(query.dateTo);
    const occurredAt = windowFilter(from, to);

    const materials = await this.prisma.client.material.findMany({
      where: {
        projectId,
        ...(query.materialId ? { id: query.materialId } : {}),
      },
      select: { id: true, name: true },
    });
    if (materials.length === 0) {
      return {
        projectId,
        dateFrom: query.dateFrom ?? null,
        dateTo: query.dateTo ?? null,
        materials: [],
      };
    }
    const materialIds = materials.map((m) => m.id);

    const [purchasedRows, writeOffRows, writeOffReversalRows] =
      await Promise.all([
        this.prisma.client.purchaseItem.groupBy({
          by: ['materialId'],
          where: {
            materialId: { in: materialIds },
            purchase: { projectId, ...(occurredAt ? { occurredAt } : {}) },
          },
          _sum: { quantity: true, lineAmountUzs: true },
        }),
        this.prisma.client.stockMovement.groupBy({
          by: ['materialId'],
          where: {
            projectId,
            materialId: { in: materialIds },
            type: StockMovementType.WRITE_OFF,
            ...(occurredAt ? { occurredAt } : {}),
          },
          _sum: { quantity: true, totalCostUzs: true },
        }),
        // Reversals of a write-off (docs/backend-architecture.md §11:
        // "Consumption aggregates original write-off costs and their
        // reversals... Classify reversals under the original type") — a
        // REVERSAL row's own `type` is `REVERSAL`, not `WRITE_OFF`, so it is
        // identified by `writeOffId` being set instead, never by `type`.
        this.prisma.client.stockMovement.groupBy({
          by: ['materialId'],
          where: {
            projectId,
            materialId: { in: materialIds },
            type: StockMovementType.REVERSAL,
            writeOffId: { not: null },
            ...(occurredAt ? { occurredAt } : {}),
          },
          _sum: { quantity: true, totalCostUzs: true },
        }),
      ]);

    const purchasedByMaterial = new Map(
      purchasedRows.map((r) => [r.materialId, r]),
    );
    const writeOffByMaterial = new Map(
      writeOffRows.map((r) => [r.materialId, r]),
    );
    const reversalByMaterial = new Map(
      writeOffReversalRows.map((r) => [r.materialId, r]),
    );

    const rows = materials.map((material) => {
      const purchased = purchasedByMaterial.get(material.id);
      const writeOff = writeOffByMaterial.get(material.id);
      const reversal = reversalByMaterial.get(material.id);
      const consumedQuantity = (writeOff?._sum.quantity ?? ZERO).minus(
        reversal?._sum.quantity ?? ZERO,
      );
      const consumedValueUzs = (writeOff?._sum.totalCostUzs ?? ZERO).minus(
        reversal?._sum.totalCostUzs ?? ZERO,
      );
      return {
        materialId: material.id,
        materialName: material.name,
        purchasedQuantity: (purchased?._sum.quantity ?? ZERO).toFixed(6),
        purchasedValueUzs: (purchased?._sum.lineAmountUzs ?? ZERO).toFixed(2),
        consumedQuantity: consumedQuantity.toFixed(6),
        consumedValueUzs: consumedValueUzs.toFixed(8),
      };
    });

    return {
      projectId,
      dateFrom: query.dateFrom ?? null,
      dateTo: query.dateTo ?? null,
      materials: rows,
    };
  }

  async getConstruction(
    user: AuthenticatedUser,
    projectId: string,
    query: ConstructionAnalyticsQueryDto,
  ): Promise<ConstructionAnalyticsResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    const from = toDate(query.dateFrom);
    const to = toDate(query.dateTo);
    const occurredAt = windowFilter(from, to);

    // Still-effective (non-cancelled) write-offs only — this phase's own
    // documented simplification of the doc's fuller "as of `to`" point-in-
    // time reconstruction (see this phase's report): a write-off cancelled
    // at any time is excluded entirely, rather than checked against
    // whether ITS OWN cancellation happened before or after `to`.
    const rows = await this.prisma.client.stockWriteOff.groupBy({
      by: ['blockId', 'floorId', 'materialId'],
      where: {
        projectId,
        cancelledAt: null,
        ...(query.blockId ? { blockId: query.blockId } : {}),
        ...(query.floorId ? { floorId: query.floorId } : {}),
        ...(occurredAt ? { occurredAt } : {}),
      },
      _sum: { quantity: true, totalCostUzs: true },
    });

    if (rows.length === 0) {
      return {
        projectId,
        dateFrom: query.dateFrom ?? null,
        dateTo: query.dateTo ?? null,
        rows: [],
      };
    }

    // Snapshots live on the write-off rows themselves, but groupBy cannot
    // return them — one more query keyed by whichever (block, floor,
    // material) triples actually appeared, not a per-row lookup.
    // No `floorId` narrowing here: a block-level write-off carries a NULL
    // floor, and SQL's `IN` never matches NULL — including it would drop
    // exactly the rows whose labels are being looked up. (block, material)
    // is narrow enough, and `distinct` still keys on the full triple.
    const sample = await this.prisma.client.stockWriteOff.findMany({
      where: {
        projectId,
        blockId: { in: [...new Set(rows.map((r) => r.blockId))] },
        materialId: { in: [...new Set(rows.map((r) => r.materialId))] },
      },
      distinct: ['blockId', 'floorId', 'materialId'],
      select: {
        blockId: true,
        floorId: true,
        materialId: true,
        blockNameSnapshot: true,
        floorLabelSnapshot: true,
        materialNameSnapshot: true,
      },
    });
    const labelKey = (
      blockId: string,
      floorId: string | null,
      materialId: string,
    ) => `${blockId}:${floorId ?? ''}:${materialId}`;
    const labels = new Map(
      sample.map((s) => [labelKey(s.blockId, s.floorId, s.materialId), s]),
    );

    return {
      projectId,
      dateFrom: query.dateFrom ?? null,
      dateTo: query.dateTo ?? null,
      rows: rows.map((row) => {
        const label = labels.get(
          labelKey(row.blockId, row.floorId, row.materialId),
        );
        return {
          blockId: row.blockId,
          blockName: label?.blockNameSnapshot ?? '',
          floorId: row.floorId,
          floorLabel: label?.floorLabelSnapshot ?? null,
          materialId: row.materialId,
          materialName: label?.materialNameSnapshot ?? '',
          quantity: (row._sum.quantity ?? ZERO).toFixed(6),
          valueUzs: (row._sum.totalCostUzs ?? ZERO).toFixed(8),
        };
      }),
    };
  }

  // ---------------------------------------------------------------------
  // Internal helpers — every one a database aggregate, never a
  // load-everything-into-Node total (docs/backend-architecture.md §11).
  // ---------------------------------------------------------------------

  private async computeBalanceBefore(
    tx: PrismaTx,
    projectId: string,
    currency: Currency,
    before: Date | undefined,
  ): Promise<Prisma.Decimal> {
    const grouped = await tx.financialTransaction.groupBy({
      by: ['direction'],
      where: {
        projectId,
        currency,
        ...(before ? { occurredAt: { lt: before } } : {}),
      },
      _sum: { amount: true },
    });
    let inSum = ZERO;
    let outSum = ZERO;
    for (const row of grouped) {
      if (row.direction === TransactionDirection.IN)
        inSum = row._sum.amount ?? inSum;
      else outSum = row._sum.amount ?? outSum;
    }
    return inSum.minus(outSum);
  }

  private async cashFlow(
    tx: PrismaTx,
    projectId: string,
    currency: Currency,
    from: Date | undefined,
    to: Date | undefined,
  ): Promise<CashFlowDto> {
    const [opening, closing, current, periodGrouped] = await Promise.all([
      this.computeBalanceBefore(tx, projectId, currency, from),
      this.computeBalanceBefore(tx, projectId, currency, to),
      this.computeBalanceBefore(tx, projectId, currency, undefined),
      tx.financialTransaction.groupBy({
        by: ['direction'],
        where: {
          projectId,
          currency,
          ...(windowFilter(from, to)
            ? { occurredAt: windowFilter(from, to) }
            : {}),
        },
        _sum: { amount: true },
      }),
    ]);
    let periodInflow = ZERO;
    let periodOutflow = ZERO;
    for (const row of periodGrouped) {
      if (row.direction === TransactionDirection.IN)
        periodInflow = row._sum.amount ?? periodInflow;
      else periodOutflow = row._sum.amount ?? periodOutflow;
    }
    return {
      opening: opening.toFixed(2),
      periodInflow: periodInflow.toFixed(2),
      periodOutflow: periodOutflow.toFixed(2),
      closing: closing.toFixed(2),
      current: current.toFixed(2),
    };
  }

  private async expensesByCategory(
    tx: PrismaTx,
    projectId: string,
    from: Date | undefined,
    to: Date | undefined,
  ) {
    const grouped = await tx.financialTransaction.groupBy({
      by: ['categoryId', 'categoryNameSnapshot'],
      where: {
        projectId,
        type: FinancialTransactionType.EXPENSE,
        ...(windowFilter(from, to)
          ? { occurredAt: windowFilter(from, to) }
          : {}),
      },
      _sum: { amountUzs: true },
    });
    return grouped
      .filter((row) => row.categoryId !== null)
      .map((row) => ({
        categoryId: row.categoryId as string,
        categoryName: row.categoryNameSnapshot ?? '(uncategorized)',
        amountUzs: (row._sum.amountUzs ?? ZERO).toFixed(2),
      }));
  }

  private async sumFinancialAmountUzs(
    tx: PrismaTx,
    projectId: string,
    type: FinancialTransactionType,
    from: Date | undefined,
    to: Date | undefined,
  ): Promise<Prisma.Decimal> {
    const result = await tx.financialTransaction.aggregate({
      where: {
        projectId,
        type,
        ...(windowFilter(from, to)
          ? { occurredAt: windowFilter(from, to) }
          : {}),
      },
      _sum: { amountUzs: true },
    });
    return result._sum.amountUzs ?? ZERO;
  }

  private async purchaseVolume(
    tx: PrismaTx,
    projectId: string,
    from: Date | undefined,
    to: Date | undefined,
  ): Promise<{ totalUzs: Prisma.Decimal; count: number }> {
    const result = await tx.purchase.aggregate({
      where: {
        projectId,
        ...(windowFilter(from, to)
          ? { occurredAt: windowFilter(from, to) }
          : {}),
      },
      _sum: { totalAmountUzs: true },
      _count: true,
    });
    return {
      totalUzs: result._sum.totalAmountUzs ?? ZERO,
      count: result._count,
    };
  }

  /**
   * "Supplier debt/advance as of `to` is reconstructed from original
   * postings and their dated reversal/settlement rows" — each purchase's
   * own currency total, less every settlement whose OWN operation was
   * dated before `to` (never a live, currently-derived balance) — grouped
   * by currency in the database, not per-purchase in Node.
   */
  private async supplierDebtAsOf(
    tx: PrismaTx,
    projectId: string,
    to: Date | undefined,
  ): Promise<CurrencyAmountDto[]> {
    const purchaseTotals = await tx.purchase.groupBy({
      by: ['currency'],
      where: { projectId, ...(to ? { occurredAt: { lt: to } } : {}) },
      _sum: { totalAmount: true },
    });
    const settlements = await tx.settlementAllocation.groupBy({
      by: ['debtCurrency', 'effect'],
      where: {
        projectId,
        ...(to
          ? {
              purchase: { occurredAt: { lt: to } },
              operation: { occurredAt: { lt: to } },
            }
          : {}),
      },
      _sum: { debtAmountSettled: true },
    });

    const byCurrency = new Map<Currency, Prisma.Decimal>();
    for (const row of purchaseTotals) {
      byCurrency.set(row.currency, row._sum.totalAmount ?? ZERO);
    }
    for (const row of settlements) {
      const current = byCurrency.get(row.debtCurrency) ?? ZERO;
      const amount = row._sum.debtAmountSettled ?? ZERO;
      byCurrency.set(
        row.debtCurrency,
        row.effect === SettlementEffect.APPLY
          ? current.minus(amount)
          : current.plus(amount),
      );
    }
    return [...byCurrency.entries()].map(([currency, amount]) => ({
      currency,
      amount: amount.toFixed(2),
    }));
  }

  private async supplierAdvancesAvailableAsOf(
    tx: PrismaTx,
    projectId: string,
    to: Date | undefined,
  ): Promise<CurrencyAmountDto[]> {
    const funded = await tx.supplierAdvance.groupBy({
      by: ['currency'],
      where: {
        projectId,
        ...(to
          ? { fundingPayment: { operation: { occurredAt: { lt: to } } } }
          : {}),
      },
      _sum: { fundedAmount: true },
    });
    const consumed = await tx.settlementAllocation.groupBy({
      by: ['settlementCurrency', 'effect'],
      where: {
        projectId,
        advanceId: { not: null },
        ...(to ? { operation: { occurredAt: { lt: to } } } : {}),
      },
      _sum: { settlementAmount: true },
    });

    const byCurrency = new Map<Currency, Prisma.Decimal>();
    for (const row of funded) {
      byCurrency.set(row.currency, row._sum.fundedAmount ?? ZERO);
    }
    for (const row of consumed) {
      const current = byCurrency.get(row.settlementCurrency) ?? ZERO;
      const amount = row._sum.settlementAmount ?? ZERO;
      byCurrency.set(
        row.settlementCurrency,
        row.effect === SettlementEffect.APPLY
          ? current.minus(amount)
          : current.plus(amount),
      );
    }
    return [...byCurrency.entries()].map(([currency, amount]) => ({
      currency,
      amount: amount.toFixed(2),
    }));
  }

  /** The current (mutable) `InventoryBalance` projection — "current
   * inventory value" only, never used for a historical `to`. */
  private async currentInventoryValue(
    tx: PrismaTx,
    projectId: string,
  ): Promise<Prisma.Decimal> {
    const result = await tx.inventoryBalance.aggregate({
      where: { projectId },
      _sum: { valueUzs: true },
    });
    return result._sum.valueUzs ?? ZERO;
  }

  /**
   * "Historical inventory value is the sum of movement value deltas before
   * `to`" — signed by direction, so every receipt/write-off/transfer leg
   * (and any reversal of one) nets out exactly, without touching the
   * current, mutable `InventoryBalance` row at all.
   */
  private async inventoryValueAsOf(
    tx: PrismaTx,
    projectId: string,
    to: Date | undefined,
  ): Promise<Prisma.Decimal> {
    const grouped = await tx.stockMovement.groupBy({
      by: ['direction'],
      where: { projectId, ...(to ? { occurredAt: { lt: to } } : {}) },
      _sum: { totalCostUzs: true },
    });
    let inSum = ZERO;
    let outSum = ZERO;
    for (const row of grouped) {
      if (row.direction === TransactionDirection.IN)
        inSum = row._sum.totalCostUzs ?? inSum;
      else outSum = row._sum.totalCostUzs ?? outSum;
    }
    return inSum.minus(outSum);
  }
}
