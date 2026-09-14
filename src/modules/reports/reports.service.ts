import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { averageCostUzs } from '../../common/inventory/costing.util.js';
import { isLowStock } from '../../common/inventory/low-stock.util.js';
import { computeRemainingDebt } from '../../common/settlement/purchase-debt.util.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma, SettlementEffect } from '../../generated/prisma/client.js';
import { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { ProjectAccessAction } from '../projects/project-access-action.enum.js';
import { ProjectAccessService } from '../projects/project-access.service.js';
import { ReportPeriodQueryDto } from './dto/report-period-query.dto.js';
import { CellValue, streamXlsxReport } from './xlsx-writer.util.js';
import { paginate } from './paginate.util.js';

const ZERO = new Prisma.Decimal(0);
const BATCH_SIZE = 500;

function occurredAtWindow(
  query: ReportPeriodQueryDto,
): Prisma.DateTimeFilter | undefined {
  if (!query.dateFrom && !query.dateTo) return undefined;
  return {
    ...(query.dateFrom
      ? { gte: new Date(`${query.dateFrom}T00:00:00.000Z`) }
      : {}),
    ...(query.dateTo ? { lt: new Date(`${query.dateTo}T00:00:00.000Z`) } : {}),
  };
}

function dateCell(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Every export in this module (docs/backend-architecture.md §11: "XLSX
 * exports cover financial transactions, purchases (including items),
 * suppliers, debts, advances, inventory balances, stock movements, and
 * material consumption by block and floor"). Each report reads directly
 * from the same authoritative tables/derivations the REST views use — no
 * separate reporting schema or cache — and every string cell goes through
 * `streamXlsxReport`'s uniform formula-injection guard (`xlsx-writer.util.ts`).
 * Read-only (`ProjectAccessAction.READ`): PROJECT_MANAGER exports only
 * their own project; OWNER/ACCOUNTANT export any active project — the
 * exact same authorization every other read view in this codebase applies,
 * per this phase's own §11.1.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  async cashLedger(
    user: AuthenticatedUser,
    projectId: string,
    query: ReportPeriodQueryDto,
    res: Response,
  ): Promise<void> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    const occurredAt = occurredAtWindow(query);

    const rows = paginate(async (skip, take) => {
      const page = await this.prisma.client.financialTransaction.findMany({
        where: { projectId, ...(occurredAt ? { occurredAt } : {}) },
        include: { createdBy: { select: { displayName: true } } },
        orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
        skip,
        take,
      });
      return page.map((row): CellValue[] => [
        dateCell(row.occurredAt),
        row.type,
        row.direction,
        row.amount.toFixed(2),
        row.currency,
        row.exchangeRate.toFixed(8),
        row.amountUzs.toFixed(2),
        row.categoryNameSnapshot,
        row.recipient,
        row.comment,
        row.createdBy.displayName,
        row.cancelledAt ? 'YES' : 'NO',
        row.cancellationReason,
        row.reversalOfId ? 'YES (reversal)' : '',
      ]);
    }, BATCH_SIZE);

    await streamXlsxReport(res, 'cash-ledger.xlsx', [
      {
        name: 'Cash Ledger',
        columns: [
          { header: 'Date' },
          { header: 'Type' },
          { header: 'Direction' },
          { header: 'Amount' },
          { header: 'Currency', width: 10 },
          { header: 'Exchange Rate' },
          { header: 'Amount (UZS)' },
          { header: 'Category' },
          { header: 'Recipient / Source' },
          { header: 'Comment', width: 30 },
          { header: 'Created By' },
          { header: 'Cancelled', width: 10 },
          { header: 'Cancellation Reason', width: 30 },
          { header: 'Reversal', width: 14 },
        ],
        rows,
      },
    ]);
  }

  async purchases(
    user: AuthenticatedUser,
    projectId: string,
    query: ReportPeriodQueryDto,
    res: Response,
  ): Promise<void> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    const occurredAt = occurredAtWindow(query);

    const purchaseRows = paginate(async (skip, take) => {
      const page = await this.prisma.client.purchase.findMany({
        where: { projectId, ...(occurredAt ? { occurredAt } : {}) },
        orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
        skip,
        take,
      });
      return page.map((row): CellValue[] => [
        dateCell(row.occurredAt),
        row.invoiceNumber,
        row.supplierNameSnapshot,
        row.warehouseNameSnapshot,
        row.currency,
        row.exchangeRate.toFixed(8),
        row.totalAmount.toFixed(2),
        row.totalAmountUzs.toFixed(2),
        row.comment,
        row.cancelledAt ? 'YES' : 'NO',
        row.cancellationReason,
      ]);
    }, BATCH_SIZE);

    const itemRows = paginate(async (skip, take) => {
      const page = await this.prisma.client.purchaseItem.findMany({
        where: {
          purchase: { projectId, ...(occurredAt ? { occurredAt } : {}) },
        },
        include: {
          purchase: {
            select: {
              invoiceNumber: true,
              occurredAt: true,
              supplierNameSnapshot: true,
            },
          },
        },
        orderBy: [{ purchase: { occurredAt: 'asc' } }, { lineNumber: 'asc' }],
        skip,
        take,
      });
      return page.map((row): CellValue[] => [
        dateCell(row.purchase.occurredAt),
        row.purchase.invoiceNumber,
        row.purchase.supplierNameSnapshot,
        row.lineNumber,
        row.materialNameSnapshot,
        row.quantity.toFixed(6),
        row.unitPrice.toFixed(8),
        row.lineAmount.toFixed(2),
        row.lineAmountUzs.toFixed(2),
      ]);
    }, BATCH_SIZE);

    await streamXlsxReport(res, 'purchases.xlsx', [
      {
        name: 'Purchases',
        columns: [
          { header: 'Date' },
          { header: 'Invoice #' },
          { header: 'Supplier' },
          { header: 'Warehouse' },
          { header: 'Currency', width: 10 },
          { header: 'Exchange Rate' },
          { header: 'Total' },
          { header: 'Total (UZS)' },
          { header: 'Comment', width: 30 },
          { header: 'Cancelled', width: 10 },
          { header: 'Cancellation Reason', width: 30 },
        ],
        rows: purchaseRows,
      },
      {
        name: 'Items',
        columns: [
          { header: 'Date' },
          { header: 'Invoice #' },
          { header: 'Supplier' },
          { header: 'Line #' },
          { header: 'Material' },
          { header: 'Quantity' },
          { header: 'Unit Price' },
          { header: 'Line Amount' },
          { header: 'Line Amount (UZS)' },
        ],
        rows: itemRows,
      },
    ]);
  }

  async suppliers(
    user: AuthenticatedUser,
    projectId: string,
    res: Response,
  ): Promise<void> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );

    // Two project-wide grouped aggregates (never per-supplier round trips —
    // docs/backend-architecture.md §11: "Avoid row-by-row supplier balance
    // calls").
    const [purchaseTotals, settlements, advanceFunded, advanceConsumed] =
      await Promise.all([
        this.prisma.client.purchase.groupBy({
          by: ['supplierId', 'currency'],
          where: { projectId },
          _sum: { totalAmount: true },
        }),
        this.prisma.client.settlementAllocation.groupBy({
          by: ['supplierId', 'debtCurrency', 'effect'],
          where: { projectId },
          _sum: { debtAmountSettled: true },
        }),
        this.prisma.client.supplierAdvance.groupBy({
          by: ['supplierId', 'currency'],
          where: { projectId },
          _sum: { fundedAmount: true },
        }),
        this.prisma.client.settlementAllocation.groupBy({
          by: ['supplierId', 'settlementCurrency', 'effect'],
          where: { projectId, advanceId: { not: null } },
          _sum: { settlementAmount: true },
        }),
      ]);

    const debtByKey = new Map<string, Prisma.Decimal>();
    for (const row of purchaseTotals) {
      debtByKey.set(
        `${row.supplierId}:${row.currency}`,
        row._sum.totalAmount ?? ZERO,
      );
    }
    for (const row of settlements) {
      const key = `${row.supplierId}:${row.debtCurrency}`;
      const current = debtByKey.get(key) ?? ZERO;
      const amount = row._sum.debtAmountSettled ?? ZERO;
      debtByKey.set(
        key,
        row.effect === SettlementEffect.APPLY
          ? current.minus(amount)
          : current.plus(amount),
      );
    }
    const advanceByKey = new Map<string, Prisma.Decimal>();
    for (const row of advanceFunded) {
      advanceByKey.set(
        `${row.supplierId}:${row.currency}`,
        row._sum.fundedAmount ?? ZERO,
      );
    }
    for (const row of advanceConsumed) {
      const key = `${row.supplierId}:${row.settlementCurrency}`;
      const current = advanceByKey.get(key) ?? ZERO;
      const amount = row._sum.settlementAmount ?? ZERO;
      advanceByKey.set(
        key,
        row.effect === SettlementEffect.APPLY
          ? current.minus(amount)
          : current.plus(amount),
      );
    }

    const rows = paginate(async (skip, take) => {
      const page = await this.prisma.client.supplier.findMany({
        where: { projectId },
        orderBy: { name: 'asc' },
        skip,
        take,
      });
      return page.map((row): CellValue[] => [
        row.name,
        row.contactPerson,
        row.phone,
        row.comment,
        row.isActive ? 'YES' : 'NO',
        (debtByKey.get(`${row.id}:UZS`) ?? ZERO).toFixed(2),
        (debtByKey.get(`${row.id}:USD`) ?? ZERO).toFixed(2),
        (advanceByKey.get(`${row.id}:UZS`) ?? ZERO).toFixed(2),
        (advanceByKey.get(`${row.id}:USD`) ?? ZERO).toFixed(2),
      ]);
    }, BATCH_SIZE);

    await streamXlsxReport(res, 'suppliers.xlsx', [
      {
        name: 'Suppliers',
        columns: [
          { header: 'Name' },
          { header: 'Contact Person' },
          { header: 'Phone' },
          { header: 'Comment', width: 30 },
          { header: 'Active', width: 10 },
          { header: 'Debt (UZS)' },
          { header: 'Debt (USD)' },
          { header: 'Available Advance (UZS)' },
          { header: 'Available Advance (USD)' },
        ],
        rows,
      },
    ]);
  }

  async debts(
    user: AuthenticatedUser,
    projectId: string,
    res: Response,
  ): Promise<void> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );

    async function* rows(this: void, client: PrismaService['client']) {
      let skip = 0;
      for (;;) {
        const page = await client.purchase.findMany({
          where: { projectId, cancelledAt: null },
          orderBy: [{ occurredAt: 'asc' }],
          skip,
          take: BATCH_SIZE,
        });
        for (const purchase of page) {
          const remaining = await computeRemainingDebt(
            client,
            purchase.id,
            purchase.totalAmount,
          );
          if (remaining.greaterThan(0)) {
            const cell: CellValue[] = [
              dateCell(purchase.occurredAt),
              purchase.invoiceNumber,
              purchase.supplierNameSnapshot,
              purchase.currency,
              purchase.totalAmount.toFixed(2),
              remaining.toFixed(2),
              remaining.equals(purchase.totalAmount)
                ? 'UNPAID'
                : 'PARTIALLY_PAID',
            ];
            yield cell;
          }
        }
        if (page.length < BATCH_SIZE) return;
        skip += BATCH_SIZE;
      }
    }

    await streamXlsxReport(res, 'supplier-debts.xlsx', [
      {
        name: 'Outstanding Debts',
        columns: [
          { header: 'Purchase Date' },
          { header: 'Invoice #' },
          { header: 'Supplier' },
          { header: 'Currency', width: 10 },
          { header: 'Total' },
          { header: 'Remaining Debt' },
          { header: 'Status', width: 16 },
        ],
        rows: rows(this.prisma.client),
      },
    ]);
  }

  async advances(
    user: AuthenticatedUser,
    projectId: string,
    res: Response,
  ): Promise<void> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );

    const rows = paginate(async (skip, take) => {
      const page = await this.prisma.client.supplierAdvance.findMany({
        where: { projectId },
        include: { supplier: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
        skip,
        take,
      });
      const consumed = await this.prisma.client.settlementAllocation.groupBy({
        by: ['advanceId', 'effect'],
        where: { advanceId: { in: page.map((a) => a.id) } },
        _sum: { settlementAmount: true },
      });
      const consumedByAdvance = new Map<string, Prisma.Decimal>();
      for (const row of consumed) {
        const key = row.advanceId as string;
        const current = consumedByAdvance.get(key) ?? ZERO;
        const amount = row._sum.settlementAmount ?? ZERO;
        consumedByAdvance.set(
          key,
          row.effect === SettlementEffect.APPLY
            ? current.plus(amount)
            : current.minus(amount),
        );
      }
      return page.map((row): CellValue[] => {
        const consumedAmount = consumedByAdvance.get(row.id) ?? ZERO;
        return [
          dateCell(row.createdAt),
          row.supplier.name,
          row.currency,
          row.fundedAmount.toFixed(2),
          row.fundedAmountUzs.toFixed(2),
          consumedAmount.toFixed(2),
          row.fundedAmount.minus(consumedAmount).toFixed(2),
        ];
      });
    }, BATCH_SIZE);

    await streamXlsxReport(res, 'supplier-advances.xlsx', [
      {
        name: 'Supplier Advances',
        columns: [
          { header: 'Funded Date' },
          { header: 'Supplier' },
          { header: 'Currency', width: 10 },
          { header: 'Funded Amount' },
          { header: 'Funded Amount (UZS)' },
          { header: 'Consumed' },
          { header: 'Available' },
        ],
        rows,
      },
    ]);
  }

  async inventory(
    user: AuthenticatedUser,
    projectId: string,
    res: Response,
  ): Promise<void> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );

    const rows = paginate(async (skip, take) => {
      const page = await this.prisma.client.inventoryBalance.findMany({
        where: { projectId },
        include: {
          warehouse: { select: { name: true } },
          material: {
            select: {
              name: true,
              minimumStock: true,
              unit: { select: { symbol: true } },
              category: { select: { name: true } },
            },
          },
        },
        orderBy: [
          { warehouse: { name: 'asc' } },
          { material: { name: 'asc' } },
        ],
        skip,
        take,
      });
      return page.map((row): CellValue[] => [
        row.warehouse.name,
        row.material.name,
        row.material.category.name,
        row.material.unit.symbol,
        row.quantity.toFixed(6),
        averageCostUzs({
          quantity: row.quantity,
          valueUzs: row.valueUzs,
        }).toFixed(8),
        row.valueUzs.toFixed(8),
        row.material.minimumStock ? row.material.minimumStock.toFixed(6) : '',
        isLowStock(row.quantity, row.material.minimumStock) ? 'YES' : 'NO',
      ]);
    }, BATCH_SIZE);

    await streamXlsxReport(res, 'inventory-balances.xlsx', [
      {
        name: 'Inventory Balances',
        columns: [
          { header: 'Warehouse' },
          { header: 'Material' },
          { header: 'Category' },
          { header: 'Unit', width: 10 },
          { header: 'Quantity' },
          { header: 'Average Cost (UZS)' },
          { header: 'Value (UZS)' },
          { header: 'Minimum Stock' },
          { header: 'Low Stock', width: 10 },
        ],
        rows,
      },
    ]);
  }

  async movements(
    user: AuthenticatedUser,
    projectId: string,
    query: ReportPeriodQueryDto,
    res: Response,
  ): Promise<void> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    const occurredAt = occurredAtWindow(query);

    const rows = paginate(async (skip, take) => {
      const page = await this.prisma.client.stockMovement.findMany({
        where: { projectId, ...(occurredAt ? { occurredAt } : {}) },
        include: {
          warehouse: { select: { name: true } },
          material: { select: { name: true } },
          createdBy: { select: { displayName: true } },
        },
        orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
        skip,
        take,
      });
      return page.map((row): CellValue[] => [
        dateCell(row.occurredAt),
        row.warehouse.name,
        row.material.name,
        row.type,
        row.direction,
        row.quantity.toFixed(6),
        row.unitCostUzs.toFixed(8),
        row.totalCostUzs.toFixed(8),
        row.createdBy.displayName,
      ]);
    }, BATCH_SIZE);

    await streamXlsxReport(res, 'stock-movements.xlsx', [
      {
        name: 'Stock Movements',
        columns: [
          { header: 'Date' },
          { header: 'Warehouse' },
          { header: 'Material' },
          { header: 'Type', width: 16 },
          { header: 'Direction', width: 10 },
          { header: 'Quantity' },
          { header: 'Unit Cost (UZS)' },
          { header: 'Total Cost (UZS)' },
          { header: 'Created By' },
        ],
        rows,
      },
    ]);
  }

  async constructionUsage(
    user: AuthenticatedUser,
    projectId: string,
    query: ReportPeriodQueryDto,
    res: Response,
  ): Promise<void> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    const occurredAt = occurredAtWindow(query);

    const rows = paginate(async (skip, take) => {
      const page = await this.prisma.client.stockWriteOff.findMany({
        where: { projectId, ...(occurredAt ? { occurredAt } : {}) },
        orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
        skip,
        take,
      });
      return page.map((row): CellValue[] => [
        dateCell(row.occurredAt),
        row.blockNameSnapshot,
        row.floorLabelSnapshot,
        row.warehouseNameSnapshot,
        row.materialNameSnapshot,
        row.quantity.toFixed(6),
        row.unitCostUzs.toFixed(8),
        row.totalCostUzs.toFixed(8),
        row.comment,
        row.cancelledAt ? 'YES' : 'NO',
      ]);
    }, BATCH_SIZE);

    await streamXlsxReport(res, 'construction-usage.xlsx', [
      {
        name: 'Block-Floor Consumption',
        columns: [
          { header: 'Date' },
          { header: 'Block' },
          { header: 'Floor' },
          { header: 'Warehouse' },
          { header: 'Material' },
          { header: 'Quantity' },
          { header: 'Unit Cost (UZS)' },
          { header: 'Total Cost (UZS)' },
          { header: 'Comment', width: 30 },
          { header: 'Cancelled', width: 10 },
        ],
        rows,
      },
    ]);
  }
}
