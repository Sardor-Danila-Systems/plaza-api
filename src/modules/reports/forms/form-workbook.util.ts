import ExcelJS from 'exceljs';
import type { Response } from 'express';

/** Russian-locale spreadsheets group thousands with a space and use a
 * decimal comma; the number format is locale-neutral, Excel localises it. */
export const MONEY_FORMAT = '#,##0.00;[Red]-#,##0.00;';
export const QUANTITY_FORMAT = '#,##0.######;[Red]-#,##0.######;';

export const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' },
};

/** Registers/forms are small (one supplier, one period), so unlike the flat
 * table exports they are built as a whole workbook in memory: merged
 * headings, totals rows and signature blocks do not fit a row stream. */
export function newFormWorkbook(): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Euro Plaza';
  workbook.created = new Date();
  return workbook;
}

export async function sendWorkbook(
  res: Response,
  filename: string,
  workbook: ExcelJS.Workbook,
): Promise<void> {
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  await workbook.xlsx.write(res);
  res.end();
}

/** Same defense-in-depth as `sanitizeForExcel` in xlsx-writer.util.ts: free
 * text typed by users (supplier names, comments) never starts with a
 * formula trigger. */
export function safeText(value: string | null | undefined): string {
  if (!value) return '';
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}
