import { Injectable, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import type ExcelJS from 'exceljs';
import { PrismaService } from '../../../database/prisma.service.js';
import {
  CashAccount,
  Currency,
  FinancialTransactionType,
  Prisma,
  SupplierPaymentPurpose,
  TransactionDirection,
} from '../../../generated/prisma/client.js';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { ProjectAccessAction } from '../../projects/project-access-action.enum.js';
import { ProjectAccessArea } from '../../projects/project-access-area.enum.js';
import { ProjectAccessService } from '../../projects/project-access.service.js';
import {
  CashJournalQueryDto,
  MaterialReportQueryDto,
  SupplierReconciliationQueryDto,
} from '../dto/form-report-queries.dto.js';
import { ReportPeriodQueryDto } from '../dto/report-period-query.dto.js';
import {
  MONEY_FORMAT,
  QUANTITY_FORMAT,
  THIN_BORDER,
  newFormWorkbook,
  safeText,
  sendWorkbook,
} from './form-workbook.util.js';
import {
  addDays,
  amountInWords,
  ruDate,
  ruLongDate,
} from './ru-format.util.js';

const ZERO = new Prisma.Decimal(0);

const ACCOUNT_LABELS: Record<CashAccount, string> = {
  CASH: 'Наличные',
  BANK: 'Банковский счёт',
};

/** `[from, toExclusive)` — `from` defaults to 1 January of the current year
 * (the 1C default), `toExclusive` to tomorrow. The `dateTo` the API receives
 * is already exclusive, the same convention as every other report. */
function resolvePeriod(query: ReportPeriodQueryDto): {
  from: Date;
  toExclusive: Date;
  lastDay: Date;
} {
  const now = new Date();
  const from = query.dateFrom
    ? new Date(`${query.dateFrom}T00:00:00.000Z`)
    : new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const toExclusive = query.dateTo
    ? new Date(`${query.dateTo}T00:00:00.000Z`)
    : addDays(
        new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
        ),
        1,
      );
  return { from, toExclusive, lastDay: addDays(toExclusive, -1) };
}

function num(value: Prisma.Decimal): number {
  return Number(value.toFixed(2));
}

function style(
  cell: ExcelJS.Cell,
  options: {
    bold?: boolean;
    align?: 'left' | 'center' | 'right';
    border?: boolean;
    fill?: string;
    numFmt?: string;
    wrap?: boolean;
    size?: number;
  } = {},
): void {
  cell.font = { name: 'Arial', size: options.size ?? 10, bold: options.bold };
  cell.alignment = {
    horizontal: options.align ?? 'left',
    vertical: 'middle',
    wrapText: options.wrap ?? false,
  };
  if (options.border) cell.border = THIN_BORDER;
  if (options.fill) {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: options.fill },
    };
  }
  if (options.numFmt) cell.numFmt = options.numFmt;
}

/** A centred, bold, merged heading line. */
function heading(
  sheet: ExcelJS.Worksheet,
  row: number,
  lastCol: number,
  text: string,
  options: { bold?: boolean; size?: number; align?: 'left' | 'center' } = {},
): void {
  sheet.mergeCells(row, 1, row, lastCol);
  const cell = sheet.getCell(row, 1);
  cell.value = text;
  style(cell, {
    bold: options.bold,
    size: options.size,
    align: options.align ?? 'center',
    wrap: true,
  });
}

const HEADER_FILL = 'FFEFEFEF';
const TOTAL_FILL = 'FFF7F7F7';

/**
 * Printable forms in the layout the company's accountants know from 1C:
 * «Акт сверки», «Материальный отчет» and «Общий кассовый журнал». Each reads
 * the same tables as every other report — no separate reporting store.
 * READ access only: a manager reads their own project, an owner or
 * accountant any, and the cash journal is also open to a cashier (it is
 * part of the cash ledger).
 */
@Injectable()
export class FormReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  // ---------------------------------------------------------------------
  // Акт сверки взаиморасчетов
  // ---------------------------------------------------------------------

  async supplierReconciliation(
    user: AuthenticatedUser,
    projectId: string,
    query: SupplierReconciliationQueryDto,
    res: Response,
  ): Promise<void> {
    const project = await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    const supplier = await this.prisma.client.supplier.findFirst({
      where: { id: query.supplierId, projectId },
    });
    if (!supplier) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Supplier not found in this project',
      });
    }
    const { from, toExclusive, lastDay } = resolvePeriod(query);

    // Cancelled documents are left out together with their reversals: both
    // sides of a cancellation net to zero, and listing them would only
    // clutter a document the counterparty has to sign.
    const [purchases, payments] = await Promise.all([
      this.prisma.client.purchase.findMany({
        where: {
          projectId,
          supplierId: supplier.id,
          cancelledAt: null,
          occurredAt: { lt: toExclusive },
        },
        orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.client.supplierPayment.findMany({
        where: {
          projectId,
          supplierId: supplier.id,
          financialTransaction: {
            is: { cancelledAt: null, occurredAt: { lt: toExclusive } },
          },
        },
        include: { financialTransaction: true },
      }),
    ]);

    interface Entry {
      date: Date;
      sortKey: number;
      document: string;
      /** We owe the supplier (a purchase) — a credit on our books. */
      credit: Prisma.Decimal;
      /** We paid the supplier — a debit on our books. */
      debit: Prisma.Decimal;
    }

    const entries: Entry[] = [];
    for (const purchase of purchases) {
      const foreign =
        purchase.currency === Currency.USD
          ? ` (${purchase.totalAmount.toFixed(2)} USD по курсу ${purchase.exchangeRate.toFixed(2)})`
          : '';
      entries.push({
        date: purchase.occurredAt,
        sortKey: purchase.createdAt.getTime(),
        document: `Поступление материалов, накладная № ${purchase.invoiceNumber ?? 'б/н'} от ${ruDate(purchase.occurredAt)}${foreign}`,
        credit: purchase.totalAmountUzs,
        debit: ZERO,
      });
    }
    const PURPOSE_LABELS: Record<SupplierPaymentPurpose, string> = {
      PURCHASE_CASH: 'Оплата при поступлении',
      DEBT_PAYMENT: 'Оплата долга',
      ADVANCE_FUNDING: 'Аванс',
    };
    for (const payment of payments) {
      const transaction = payment.financialTransaction!;
      const foreign =
        payment.currency === Currency.USD
          ? ` (${payment.amount.toFixed(2)} USD по курсу ${payment.exchangeRate.toFixed(2)})`
          : '';
      const note = payment.comment ? `, ${payment.comment}` : '';
      entries.push({
        date: transaction.occurredAt,
        sortKey: payment.createdAt.getTime(),
        document: `${PURPOSE_LABELS[payment.purpose]} от ${ruDate(transaction.occurredAt)}, ${ACCOUNT_LABELS[transaction.account].toLowerCase()}${foreign}${note}`,
        credit: ZERO,
        debit: payment.amountUzs,
      });
    }
    entries.sort(
      (a, b) => a.date.getTime() - b.date.getTime() || a.sortKey - b.sortKey,
    );

    const sum = (list: Entry[], key: 'debit' | 'credit'): Prisma.Decimal =>
      list.reduce((total, entry) => total.plus(entry[key]), ZERO);

    const opening = entries.filter((e) => e.date < from);
    const period = entries.filter((e) => e.date >= from);
    const openingNet = sum(opening, 'debit').minus(sum(opening, 'credit'));
    const periodDebit = sum(period, 'debit');
    const periodCredit = sum(period, 'credit');
    const closingNet = openingNet.plus(periodDebit).minus(periodCredit);

    const orgName = project.name;
    const supplierName = supplier.name;

    const workbook = newFormWorkbook();
    const sheet = workbook.addWorksheet('Акт сверки', {
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToHeight: 0 },
    });
    sheet.columns = [
      { width: 64 },
      { width: 13 },
      { width: 19 },
      { width: 19 },
      { width: 19 },
      { width: 19 },
    ];

    heading(sheet, 1, 6, 'АКТ СВЕРКИ ВЗАИМОРАСЧЕТОВ', { bold: true, size: 13 });
    heading(
      sheet,
      2,
      6,
      `между «${safeText(orgName)}» и «${safeText(supplierName)}»${supplier.taxId ? ` (ИНН ${supplier.taxId})` : ''}`,
    );
    heading(sheet, 3, 6, `за период: ${ruDate(from)} — ${ruDate(lastDay)}`);
    heading(
      sheet,
      4,
      6,
      `Мы, нижеподписавшиеся, произвели сверку взаиморасчетов на ${ruLongDate(lastDay)}. Все суммы — в сумах (по курсу на день операции).`,
      { align: 'left' },
    );
    sheet.getRow(4).height = 30;

    // Two-row header: the document and date, then our books and the supplier's.
    sheet.mergeCells(6, 1, 7, 1);
    sheet.mergeCells(6, 2, 7, 2);
    sheet.mergeCells(6, 3, 6, 4);
    sheet.mergeCells(6, 5, 6, 6);
    sheet.getCell(6, 1).value = 'Документ';
    sheet.getCell(6, 2).value = 'Дата';
    sheet.getCell(6, 3).value = `По данным «${safeText(orgName)}»`;
    sheet.getCell(6, 5).value = `По данным «${safeText(supplierName)}»`;
    ['Дебет', 'Кредит', 'Дебет', 'Кредит'].forEach((label, i) => {
      sheet.getCell(7, 3 + i).value = label;
    });
    for (let row = 6; row <= 7; row++) {
      for (let col = 1; col <= 6; col++) {
        style(sheet.getCell(row, col), {
          bold: true,
          align: 'center',
          border: true,
          fill: HEADER_FILL,
          wrap: true,
        });
      }
    }

    let rowIndex = 8;
    /** Our debit/credit, and the supplier's mirror of them. */
    const writeAmounts = (
      row: number,
      debit: Prisma.Decimal,
      credit: Prisma.Decimal,
      options: { bold?: boolean; fill?: string },
    ): void => {
      const values = [debit, credit, credit, debit];
      values.forEach((value, i) => {
        const cell = sheet.getCell(row, 3 + i);
        cell.value = value.isZero() ? null : num(value);
        style(cell, {
          ...options,
          align: 'right',
          border: true,
          numFmt: MONEY_FORMAT,
        });
      });
    };
    const writeLine = (
      label: string,
      date: string,
      debit: Prisma.Decimal,
      credit: Prisma.Decimal,
      options: { bold?: boolean; fill?: string } = {},
    ): void => {
      sheet.getCell(rowIndex, 1).value = label;
      sheet.getCell(rowIndex, 2).value = date;
      style(sheet.getCell(rowIndex, 1), {
        ...options,
        border: true,
        wrap: true,
      });
      style(sheet.getCell(rowIndex, 2), {
        ...options,
        align: 'center',
        border: true,
      });
      writeAmounts(rowIndex, debit, credit, options);
      rowIndex += 1;
    };
    /** A net balance goes to one side only: positive net = the supplier owes
     * us (debit), negative = we owe the supplier (credit). */
    const sides = (net: Prisma.Decimal): [Prisma.Decimal, Prisma.Decimal] =>
      net.isNegative() ? [ZERO, net.abs()] : [net, ZERO];

    writeLine(`Сальдо на ${ruDate(from)}`, '', ...sides(openingNet), {
      bold: true,
    });
    for (const entry of period) {
      writeLine(
        safeText(entry.document),
        ruDate(entry.date),
        entry.debit,
        entry.credit,
      );
    }
    writeLine('Обороты за период', '', periodDebit, periodCredit, {
      bold: true,
      fill: TOTAL_FILL,
    });
    writeLine(`Сальдо на ${ruDate(lastDay)}`, '', ...sides(closingNet), {
      bold: true,
      fill: TOTAL_FILL,
    });

    rowIndex += 1;
    const closingAbs = closingNet.abs();
    const conclusion = closingNet.isZero()
      ? `По данным сверки взаиморасчеты на ${ruLongDate(lastDay)} сторонами не имеют задолженности.`
      : `Исходя из вышеуказанных данных, задолженность на ${ruLongDate(lastDay)} в пользу «${safeText(closingNet.isNegative() ? supplierName : orgName)}» составляет ${closingAbs.toFixed(2)} сум (${amountInWords(closingAbs)}).`;
    heading(sheet, rowIndex, 6, conclusion, { align: 'left' });
    sheet.getRow(rowIndex).height = 32;
    rowIndex += 3;

    sheet.getCell(rowIndex, 1).value = `От «${safeText(orgName)}»`;
    sheet.getCell(rowIndex, 3).value = `От «${safeText(supplierName)}»`;
    style(sheet.getCell(rowIndex, 1), { bold: true });
    style(sheet.getCell(rowIndex, 3), { bold: true });
    rowIndex += 3;
    sheet.getCell(rowIndex, 1).value =
      '______________________ / ______________________';
    sheet.getCell(rowIndex, 3).value =
      '______________________ / ______________________';
    style(sheet.getCell(rowIndex, 1));
    style(sheet.getCell(rowIndex, 3));

    await sendWorkbook(res, 'akt-sverki.xlsx', workbook);
  }

  // ---------------------------------------------------------------------
  // Материальный отчет
  // ---------------------------------------------------------------------

  async materialReport(
    user: AuthenticatedUser,
    projectId: string,
    query: MaterialReportQueryDto,
    res: Response,
  ): Promise<void> {
    const project = await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    const { from, toExclusive, lastDay } = resolvePeriod(query);

    let warehouseName = 'Все склады';
    if (query.warehouseId) {
      const warehouse = await this.prisma.client.warehouse.findFirst({
        where: { id: query.warehouseId, projectId },
      });
      if (!warehouse) {
        throw new NotFoundException({
          code: 'NOT_FOUND',
          message: 'Warehouse not found in this project',
        });
      }
      warehouseName = warehouse.name;
    }
    const warehouseFilter = query.warehouseId
      ? { warehouseId: query.warehouseId }
      : {};

    const grouped = (occurredAt: Prisma.DateTimeFilter) =>
      this.prisma.client.stockMovement.groupBy({
        by: ['materialId', 'direction'],
        where: { projectId, ...warehouseFilter, occurredAt },
        _sum: { quantity: true, totalCostUzs: true },
      });
    const [before, within] = await Promise.all([
      grouped({ lt: from }),
      grouped({ gte: from, lt: toExclusive }),
    ]);

    interface Totals {
      openQty: Prisma.Decimal;
      openSum: Prisma.Decimal;
      inQty: Prisma.Decimal;
      inSum: Prisma.Decimal;
      outQty: Prisma.Decimal;
      outSum: Prisma.Decimal;
    }
    const totals = new Map<string, Totals>();
    const entry = (materialId: string): Totals => {
      let found = totals.get(materialId);
      if (!found) {
        found = {
          openQty: ZERO,
          openSum: ZERO,
          inQty: ZERO,
          inSum: ZERO,
          outQty: ZERO,
          outSum: ZERO,
        };
        totals.set(materialId, found);
      }
      return found;
    };
    for (const row of before) {
      const t = entry(row.materialId);
      const sign = row.direction === TransactionDirection.IN ? 1 : -1;
      const qty = row._sum.quantity ?? ZERO;
      const value = row._sum.totalCostUzs ?? ZERO;
      t.openQty = t.openQty.plus(sign === 1 ? qty : qty.negated());
      t.openSum = t.openSum.plus(sign === 1 ? value : value.negated());
    }
    for (const row of within) {
      const t = entry(row.materialId);
      const qty = row._sum.quantity ?? ZERO;
      const value = row._sum.totalCostUzs ?? ZERO;
      if (row.direction === TransactionDirection.IN) {
        t.inQty = t.inQty.plus(qty);
        t.inSum = t.inSum.plus(value);
      } else {
        t.outQty = t.outQty.plus(qty);
        t.outSum = t.outSum.plus(value);
      }
    }

    const materials = await this.prisma.client.material.findMany({
      where: { projectId, id: { in: [...totals.keys()] } },
      include: { unit: { select: { symbol: true } } },
      orderBy: { name: 'asc' },
    });

    const workbook = newFormWorkbook();
    const sheet = workbook.addWorksheet('Материальный отчет', {
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToHeight: 0 },
    });
    sheet.columns = [
      { width: 6 },
      { width: 40 },
      { width: 14 },
      { width: 9 },
      { width: 16 },
      { width: 12 },
      { width: 18 },
      { width: 12 },
      { width: 18 },
      { width: 12 },
      { width: 18 },
      { width: 12 },
      { width: 18 },
    ];
    const LAST = 13;

    heading(sheet, 1, LAST, safeText(project.name), { align: 'left' });
    heading(
      sheet,
      2,
      LAST,
      `Материальный отчет за ${ruDate(from)} - ${ruDate(lastDay)}`,
      { bold: true, size: 13 },
    );
    heading(sheet, 3, LAST, `Склад: ${safeText(warehouseName)}`);

    // Header, two rows like the 1C form: group titles, then Кол-во / Сумма.
    const groups: Array<[string, number]> = [
      ['Сальдо на начало периода', 6],
      ['Приход', 8],
      ['Расход', 10],
      ['Сальдо на конец периода', 12],
    ];
    const fixed: Array<[string, number]> = [
      ['№№', 1],
      ['Наименование', 2],
      ['Код в справочнике', 3],
      ['Ед. изм.', 4],
      ['Цена учетная', 5],
    ];
    for (const [label, col] of fixed) {
      sheet.mergeCells(5, col, 6, col);
      sheet.getCell(5, col).value = label;
    }
    for (const [label, col] of groups) {
      sheet.mergeCells(5, col, 5, col + 1);
      sheet.getCell(5, col).value = label;
      sheet.getCell(6, col).value = 'Кол-во';
      sheet.getCell(6, col + 1).value = 'Сумма';
    }
    for (let row = 5; row <= 6; row++) {
      for (let col = 1; col <= LAST; col++) {
        style(sheet.getCell(row, col), {
          bold: true,
          align: 'center',
          border: true,
          fill: HEADER_FILL,
          wrap: true,
        });
      }
    }

    const grand = {
      openQty: ZERO,
      openSum: ZERO,
      inQty: ZERO,
      inSum: ZERO,
      outQty: ZERO,
      outSum: ZERO,
      closeQty: ZERO,
      closeSum: ZERO,
    };
    let rowIndex = 7;
    let lineNumber = 0;
    for (const material of materials) {
      const t = totals.get(material.id)!;
      const closeQty = t.openQty.plus(t.inQty).minus(t.outQty);
      const closeSum = t.openSum.plus(t.inSum).minus(t.outSum);
      // Skip materials that never moved and hold nothing.
      if (
        [t.openQty, t.inQty, t.outQty, closeQty].every((value) =>
          value.isZero(),
        )
      ) {
        continue;
      }
      lineNumber += 1;
      const price = closeQty.isZero() ? ZERO : closeSum.dividedBy(closeQty);
      const cells: Array<string | number | null> = [
        lineNumber,
        safeText(material.name),
        safeText(material.code),
        material.unit.symbol,
        num(price),
        Number(t.openQty.toFixed(6)),
        num(t.openSum),
        Number(t.inQty.toFixed(6)),
        num(t.inSum),
        Number(t.outQty.toFixed(6)),
        num(t.outSum),
        Number(closeQty.toFixed(6)),
        num(closeSum),
      ];
      cells.forEach((value, i) => {
        const cell = sheet.getCell(rowIndex, i + 1);
        cell.value = value === 0 && i >= 5 ? null : value;
        const isQuantity = i >= 5 && i % 2 === 1;
        style(cell, {
          border: true,
          align: i === 1 ? 'left' : i < 4 ? 'center' : 'right',
          numFmt:
            i < 5 ? undefined : isQuantity ? QUANTITY_FORMAT : MONEY_FORMAT,
        });
      });
      grand.openQty = grand.openQty.plus(t.openQty);
      grand.openSum = grand.openSum.plus(t.openSum);
      grand.inQty = grand.inQty.plus(t.inQty);
      grand.inSum = grand.inSum.plus(t.inSum);
      grand.outQty = grand.outQty.plus(t.outQty);
      grand.outSum = grand.outSum.plus(t.outSum);
      grand.closeQty = grand.closeQty.plus(closeQty);
      grand.closeSum = grand.closeSum.plus(closeSum);
      rowIndex += 1;
    }

    sheet.getCell(rowIndex, 2).value = 'Итого';
    [
      grand.openQty,
      grand.openSum,
      grand.inQty,
      grand.inSum,
      grand.outQty,
      grand.outSum,
      grand.closeQty,
      grand.closeSum,
    ].forEach((value, i) => {
      sheet.getCell(rowIndex, 6 + i).value = value.isZero()
        ? null
        : Number(value.toFixed(i % 2 === 0 ? 6 : 2));
    });
    for (let col = 1; col <= LAST; col++) {
      const cell = sheet.getCell(rowIndex, col);
      style(cell, {
        bold: true,
        border: true,
        fill: TOTAL_FILL,
        align: col === 2 ? 'left' : 'right',
        numFmt:
          col < 6 ? undefined : col % 2 === 0 ? QUANTITY_FORMAT : MONEY_FORMAT,
      });
    }
    sheet.views = [{ state: 'frozen', ySplit: 6 }];

    await sendWorkbook(res, 'material-report.xlsx', workbook);
  }

  // ---------------------------------------------------------------------
  // Общий кассовый журнал
  // ---------------------------------------------------------------------

  async cashJournal(
    user: AuthenticatedUser,
    projectId: string,
    query: CashJournalQueryDto,
    res: Response,
  ): Promise<void> {
    // A cashier runs this ledger, so the journal belongs to the cash area.
    const project = await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
      ProjectAccessArea.CASH,
    );
    const { from, toExclusive, lastDay } = resolvePeriod(query);
    const accountFilter = query.account ? { account: query.account } : {};

    // Cancelled operations are excluded together with their reversal rows.
    const live = {
      projectId,
      ...accountFilter,
      cancelledAt: null,
      reversalOfId: null,
    };
    const [openingRows, transactions] = await Promise.all([
      this.prisma.client.financialTransaction.groupBy({
        by: ['currency', 'direction'],
        where: { ...live, occurredAt: { lt: from } },
        _sum: { amount: true },
      }),
      this.prisma.client.financialTransaction.findMany({
        where: { ...live, occurredAt: { gte: from, lt: toExclusive } },
        include: {
          operation: { select: { sequence: true } },
          supplierPayment: {
            select: { supplier: { select: { name: true } } },
          },
        },
        orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);

    const openingByCurrency = new Map<Currency, Prisma.Decimal>();
    for (const row of openingRows) {
      const amount = row._sum.amount ?? ZERO;
      openingByCurrency.set(
        row.currency,
        (openingByCurrency.get(row.currency) ?? ZERO).plus(
          row.direction === TransactionDirection.IN ? amount : amount.negated(),
        ),
      );
    }

    const workbook = newFormWorkbook();
    const sheet = workbook.addWorksheet('Кассовый журнал', {
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToHeight: 0 },
    });
    sheet.columns = [
      { width: 6 },
      { width: 12 },
      { width: 10 },
      { width: 30 },
      { width: 30 },
      { width: 24 },
      { width: 36 },
      { width: 18 },
      { width: 18 },
      { width: 20 },
    ];
    const LAST = 10;

    heading(sheet, 1, LAST, safeText(project.name), { align: 'left' });
    heading(sheet, 2, LAST, 'Общий кассовый журнал', { bold: true, size: 13 });
    heading(
      sheet,
      3,
      LAST,
      `за период ${ruDate(from)} - ${ruDate(lastDay)}. Касса: ${query.account ? ACCOUNT_LABELS[query.account] : 'все кассы (наличные и банковский счёт)'}`,
    );

    const currencies: Currency[] = [Currency.UZS, Currency.USD].filter(
      (currency) =>
        currency === Currency.UZS ||
        !(openingByCurrency.get(currency) ?? ZERO).isZero() ||
        transactions.some((tx) => tx.currency === currency),
    );

    let rowIndex = 5;
    for (const currency of currencies) {
      const rows = transactions.filter((tx) => tx.currency === currency);
      const opening = openingByCurrency.get(currency) ?? ZERO;

      heading(
        sheet,
        rowIndex,
        LAST,
        currency === Currency.UZS ? 'Сумы (UZS)' : 'Доллары США (USD)',
        { bold: true, align: 'left' },
      );
      rowIndex += 1;

      [
        '№',
        'Дата',
        '№ док.',
        'Документ',
        'Корреспондент',
        'Статья',
        'Основание',
        'Приход',
        'Расход',
        'Остаток',
      ].forEach((label, i) => {
        const cell = sheet.getCell(rowIndex, i + 1);
        cell.value = label;
        style(cell, {
          bold: true,
          align: 'center',
          border: true,
          fill: HEADER_FILL,
          wrap: true,
        });
      });
      rowIndex += 1;

      const writeSummary = (
        label: string,
        income: Prisma.Decimal | null,
        expense: Prisma.Decimal | null,
        balance: Prisma.Decimal,
      ): void => {
        sheet.mergeCells(rowIndex, 1, rowIndex, 7);
        sheet.getCell(rowIndex, 1).value = label;
        style(sheet.getCell(rowIndex, 1), {
          bold: true,
          border: true,
          fill: TOTAL_FILL,
        });
        [income, expense, balance].forEach((value, i) => {
          const cell = sheet.getCell(rowIndex, 8 + i);
          cell.value = value && !value.isZero() ? num(value) : null;
          style(cell, {
            bold: true,
            border: true,
            fill: TOTAL_FILL,
            align: 'right',
            numFmt: MONEY_FORMAT,
          });
        });
        rowIndex += 1;
      };

      writeSummary(`Остаток на ${ruDate(from)}`, null, null, opening);

      let balance = opening;
      let totalIn = ZERO;
      let totalOut = ZERO;
      rows.forEach((tx, index) => {
        const isIn = tx.direction === TransactionDirection.IN;
        balance = isIn ? balance.plus(tx.amount) : balance.minus(tx.amount);
        if (isIn) totalIn = totalIn.plus(tx.amount);
        else totalOut = totalOut.plus(tx.amount);

        const documentLabel = isIn
          ? 'Приходный кассовый ордер'
          : tx.type === FinancialTransactionType.SALARY
            ? 'Расходный кассовый ордер (зарплата)'
            : 'Расходный кассовый ордер';
        const correspondent =
          tx.recipient ?? tx.supplierPayment?.supplier.name ?? '';
        const cells: Array<string | number | null> = [
          index + 1,
          ruDate(tx.occurredAt),
          Number(tx.operation.sequence),
          documentLabel,
          safeText(correspondent),
          safeText(tx.categoryNameSnapshot),
          safeText(tx.comment),
          isIn ? num(tx.amount) : null,
          isIn ? null : num(tx.amount),
          num(balance),
        ];
        cells.forEach((value, i) => {
          const cell = sheet.getCell(rowIndex, i + 1);
          cell.value = value;
          style(cell, {
            border: true,
            wrap: i >= 3 && i <= 6,
            align: i < 3 ? 'center' : i >= 7 ? 'right' : 'left',
            numFmt: i >= 7 ? MONEY_FORMAT : undefined,
          });
        });
        rowIndex += 1;
      });

      writeSummary('Обороты за период', totalIn, totalOut, balance);
      writeSummary(`Остаток на ${ruDate(lastDay)}`, null, null, balance);
      rowIndex += 2;
    }
    sheet.views = [{ state: 'frozen', ySplit: 3 }];

    await sendWorkbook(res, 'cash-journal.xlsx', workbook);
  }
}
