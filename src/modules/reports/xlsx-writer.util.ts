import ExcelJS from 'exceljs';
import type { Response } from 'express';

export type CellValue = string | number | Date | null;

export interface ReportColumn {
  header: string;
  width?: number;
}

export interface ReportSheet {
  name: string;
  columns: ReportColumn[];
  /** Bounded-batch source, never one giant array held entirely in memory
   * (docs/backend-architecture.md §11: "Stream rows in bounded batches...
   * do not load the entire system dataset into memory unnecessarily") —
   * every report builds this from a cursor-paginated Prisma query. */
  rows: AsyncIterable<CellValue[]>;
}

/**
 * Leading `=`, `+`, `-`, `@`, or a tab/CR is the classic CSV-injection
 * trigger (a formula some spreadsheet import path might evaluate on open).
 * A native XLSX string cell is not itself vulnerable the way a CSV import
 * is (this writer never creates an actual formula-type cell — see below),
 * but this project's own test suite verifies the defense-in-depth anyway
 * (Phase 12's own review explicitly calls this out): prefix a single quote
 * so the value can never be mistaken for one, in any consumer.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function sanitizeForExcel(value: string): string {
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

function toCellValue(value: CellValue): string | number | Date | null {
  if (typeof value === 'string') {
    // Every decimal/quantity/rate figure in this codebase is ALREADY a
    // string by the time it reaches a report (never a JS `number`, per
    // docs/backend-architecture.md §4) — storing it as an ExcelJS string
    // cell writes an OOXML inline/shared-STRING cell, not a numeric one,
    // so Excel can never silently round it to a float
    // (docs/backend-architecture.md §11: "Export exact decimal strings as
    // text cells to avoid losing precision in Excel numeric cells").
    return sanitizeForExcel(value);
  }
  return value;
}

/**
 * The one place every XLSX report in this module builds its actual
 * workbook — frozen header row, sized columns, and the string-cell/
 * formula-injection discipline above applied uniformly, so no individual
 * report has to remember any of it. Uses ExcelJS's streaming
 * `WorkbookWriter` piped straight to the HTTP response (never accumulates
 * the whole workbook in Node memory) — see docs/backend-architecture.md
 * §11's "use streaming workbook generation" and this phase's own report
 * for why that matters even at this project's modest expected scale.
 */
export async function streamXlsxReport(
  res: Response,
  filename: string,
  sheets: ReportSheet[],
): Promise<void> {
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: res,
    useStyles: true,
  });

  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name, {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    worksheet.columns = sheet.columns.map((column) => ({
      header: column.header,
      width: column.width ?? 20,
    }));
    for await (const row of sheet.rows) {
      worksheet.addRow(row.map(toCellValue)).commit();
    }
    worksheet.commit();
  }

  await workbook.commit();
}
