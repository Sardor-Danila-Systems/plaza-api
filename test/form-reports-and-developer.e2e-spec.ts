import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { Response as SuperAgentResponse } from 'superagent';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Role } from '../src/generated/prisma/client.js';
import { setupApp } from '../src/setup-app.js';
import {
  createTestProject,
  createTestSupplier,
  createTestUser,
  deleteTestProject,
  loginTestUser,
} from './fixtures/auth.fixture.js';

function bufferParser(
  res: SuperAgentResponse,
  callback: (err: Error | null, body: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
  );
  return workbook;
}

/** Every cell of a worksheet as plain text, row by row. */
function rowsOf(
  sheet: ExcelJS.Worksheet,
): Array<Array<string | number | null>> {
  const rows: Array<Array<string | number | null>> = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: Array<string | number | null> = [];
    for (let col = 1; col <= sheet.columnCount; col++) {
      const value = row.getCell(col).value;
      cells.push(
        value === null || value === undefined
          ? null
          : typeof value === 'object'
            ? String((value as { text?: string }).text ?? '')
            : (value as string | number),
      );
    }
    rows.push(cells);
  });
  return rows;
}

describe('1C-layout reports and the developer role (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  const idem = () => randomUUID();

  async function setup() {
    const project = await createTestProject(
      prisma.client,
      `Forms Test ${randomUUID()}`,
    );
    const manager = await createTestUser(prisma.client, {
      role: Role.PROJECT_MANAGER,
      projectId: project.id,
    });
    const token = await loginTestUser(app.getHttpServer(), manager.email);
    return { project, manager, token };
  }

  function post(path: string, token: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idem())
      .send(body);
  }

  async function download(path: string, token: string) {
    const res = await request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse(bufferParser)
      .expect(200);
    return loadWorkbook(res.body as Buffer);
  }

  it('builds an Акт сверки with opening balance, documents, turnover and closing balance', async () => {
    const { project, token } = await setup();
    try {
      const base = `/projects/${project.id}`;
      const supplier = await createTestSupplier(prisma.client, project.id);
      const warehouse = await prisma.client.warehouse.create({
        data: { projectId: project.id, name: 'WH', code: `wh-${randomUUID()}` },
      });
      const category = await prisma.client.materialCategory.create({
        data: { projectId: project.id, name: 'Cat' },
      });
      const unit = await prisma.client.unit.create({
        data: { projectId: project.id, symbol: 'kg', name: 'Kilogram' },
      });
      const material = await prisma.client.material.create({
        data: {
          projectId: project.id,
          categoryId: category.id,
          unitId: unit.id,
          name: 'Cement',
          code: `mat-${randomUUID()}`,
        },
      });
      await post(`${base}/finances`, token, {
        type: 'INCOME',
        amount: '5000000.00',
        currency: 'UZS',
        occurredAt: '2026-07-01',
      }).expect(201);

      const purchase = (invoice: string, date: string, paid: string) =>
        post(`${base}/purchases`, token, {
          supplierId: supplier.id,
          warehouseId: warehouse.id,
          currency: 'UZS',
          items: [
            {
              materialId: material.id,
              quantity: '10.000000',
              unitPrice: '100000.00000000',
            },
          ],
          cashPaid: paid,
          invoiceNumber: invoice,
          occurredAt: date,
        }).expect(201);

      // Before the period: 1 000 000 owed, 300 000 paid -> we owe 700 000.
      await purchase('OLD-1', '2026-07-10', '300000.00');
      // In the period: 1 000 000 more, 400 000 paid at receipt.
      const inPeriod = await purchase('NEW-2', '2026-09-10', '400000.00');
      await post(`${base}/suppliers/${supplier.id}/debt-payments`, token, {
        purchaseId: inPeriod.body.id,
        currency: 'UZS',
        amount: '200000.00',
        occurredAt: '2026-09-12',
      }).expect(201);

      const workbook = await download(
        `${base}/reports/supplier-reconciliation.xlsx?supplierId=${supplier.id}&dateFrom=2026-09-01&dateTo=2026-09-18`,
        token,
      );
      const rows = rowsOf(workbook.getWorksheet('Акт сверки')!);
      const find = (text: string) =>
        rows.find(
          (row) => typeof row[0] === 'string' && row[0].startsWith(text),
        )!;

      expect(rows[0][0]).toBe('АКТ СВЕРКИ ВЗАИМОРАСЧЕТОВ');
      // Opening: net credit 700 000 on our side, mirrored on the supplier's.
      expect(find('Сальдо на 01.09.2026').slice(2)).toEqual([
        null,
        700000,
        700000,
        null,
      ]);
      // The two documents of the period.
      expect(
        rows.filter((row) => String(row[0]).includes('NEW-2')),
      ).toHaveLength(1);
      expect(
        rows.filter((row) => String(row[0]).startsWith('Оплата долга')),
      ).toHaveLength(1);
      // Turnover: payments 600 000 (debit), purchases 1 000 000 (credit).
      expect(find('Обороты за период').slice(2)).toEqual([
        600000, 1000000, 1000000, 600000,
      ]);
      // Closing: 700 000 + 1 000 000 - 600 000 = 1 100 000 owed.
      expect(find('Сальдо на 17.09.2026').slice(2)).toEqual([
        null,
        1100000,
        1100000,
        null,
      ]);
      const conclusion = rows
        .map((r) => String(r[0]))
        .find((t) => t.startsWith('Исходя'))!;
      expect(conclusion).toContain('1100000.00 сум');
      expect(conclusion).toContain('Один миллион сто тысяч сумов 00 тийин');

      // The old purchase is not listed as a document — only in the balance.
      expect(rows.some((row) => String(row[0]).includes('OLD-1'))).toBe(false);
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });

  it('builds a Материальный отчет with opening, receipts, issues and closing balance', async () => {
    const { project, token } = await setup();
    try {
      const base = `/projects/${project.id}`;
      const supplier = await createTestSupplier(prisma.client, project.id);
      const warehouse = await prisma.client.warehouse.create({
        data: {
          projectId: project.id,
          name: 'Main WH',
          code: `wh-${randomUUID()}`,
        },
      });
      const category = await prisma.client.materialCategory.create({
        data: { projectId: project.id, name: 'Cat' },
      });
      const unit = await prisma.client.unit.create({
        data: { projectId: project.id, symbol: 'шт', name: 'Piece' },
      });
      const material = await prisma.client.material.create({
        data: {
          projectId: project.id,
          categoryId: category.id,
          unitId: unit.id,
          name: 'Монитор',
          code: `mat-${randomUUID()}`,
        },
      });
      const buy = (qty: string, price: string, date: string) =>
        post(`${base}/purchases`, token, {
          supplierId: supplier.id,
          warehouseId: warehouse.id,
          currency: 'UZS',
          items: [{ materialId: material.id, quantity: qty, unitPrice: price }],
          occurredAt: date,
        }).expect(201);
      await buy('2.000000', '1000.00000000', '2026-08-01'); // opening: 2 / 2000
      await buy('3.000000', '2000.00000000', '2026-09-05'); // receipt: 3 / 6000

      const workbook = await download(
        `${base}/reports/material-report.xlsx?dateFrom=2026-09-01&dateTo=2026-09-18&warehouseId=${warehouse.id}`,
        token,
      );
      const rows = rowsOf(workbook.getWorksheet('Материальный отчет')!);
      expect(rows[1][0]).toBe('Материальный отчет за 01.09.2026 - 17.09.2026');
      expect(rows[2][0]).toBe('Склад: Main WH');
      const line = rows.find((row) => row[1] === 'Монитор')!;
      // №, name, code, unit, price, open qty/sum, in qty/sum, out qty/sum, close qty/sum
      expect(line[3]).toBe('шт');
      expect(line.slice(5)).toEqual([2, 2000, 3, 6000, null, null, 5, 8000]);
      expect(line[4]).toBe(1600);
      const total = rows.find((row) => row[1] === 'Итого')!;
      expect(total.slice(5)).toEqual([2, 2000, 3, 6000, null, null, 5, 8000]);
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });

  it('builds an Общий кассовый журнал with a running balance per currency, and cashiers may download it', async () => {
    const { project, token } = await setup();
    try {
      const base = `/projects/${project.id}`;
      await post(`${base}/finances`, token, {
        type: 'INCOME',
        amount: '1000000.00',
        currency: 'UZS',
        occurredAt: '2026-08-15',
      }).expect(201);
      await post(`${base}/finances`, token, {
        type: 'EXPENSE',
        amount: '250000.00',
        currency: 'UZS',
        recipient: 'Ali',
        occurredAt: '2026-09-03',
      }).expect(201);
      const cancelled = await post(`${base}/finances`, token, {
        type: 'EXPENSE',
        amount: '999.00',
        currency: 'UZS',
        occurredAt: '2026-09-04',
      }).expect(201);
      await post(`${base}/finances/${cancelled.body.id}/cancel`, token, {
        reason: 'ошибка',
      }).expect(200);

      const cashier = await createTestUser(prisma.client, {
        role: Role.CASHIER,
        projectId: project.id,
      });
      const cashierToken = await loginTestUser(
        app.getHttpServer(),
        cashier.email,
      );
      const workbook = await download(
        `${base}/reports/cash-journal.xlsx?dateFrom=2026-09-01&dateTo=2026-09-18&account=CASH`,
        cashierToken,
      );
      const rows = rowsOf(workbook.getWorksheet('Кассовый журнал')!);
      const find = (text: string) =>
        rows.find(
          (row) => typeof row[0] === 'string' && row[0].startsWith(text),
        )!;
      expect(find('Остаток на 01.09.2026').slice(7)).toEqual([
        null,
        null,
        1000000,
      ]);
      const expense = rows.find((row) => row[4] === 'Ali')!;
      expect(expense[3]).toBe('Расходный кассовый ордер');
      expect(expense.slice(7)).toEqual([null, 250000, 750000]);
      // The cancelled operation and its reversal are not listed.
      expect(rows.some((row) => row[7] === 999 || row[8] === 999)).toBe(false);
      expect(find('Обороты за период').slice(7)).toEqual([
        null,
        250000,
        750000,
      ]);
      expect(find('Остаток на 17.09.2026').slice(7)).toEqual([
        null,
        null,
        750000,
      ]);

      // But a cashier may not pull the supplier act (outside the cash area).
      await request(app.getHttpServer())
        .get(`${base}/reports/material-report.xlsx`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(403);
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });

  it('lets a cashier read and add currency rates, since cash forms need them', async () => {
    const { project } = await setup();
    try {
      const cashier = await createTestUser(prisma.client, {
        role: Role.CASHIER,
        projectId: project.id,
      });
      const token = await loginTestUser(app.getHttpServer(), cashier.email);
      await post(`/projects/${project.id}/currency-rates`, token, {
        currency: 'USD',
        rateUzs: '12500.00',
        effectiveOn: '2026-10-01',
      }).expect(201);
      await request(app.getHttpServer())
        .get(`/projects/${project.id}/currency-rates`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });

  it('gives DEVELOPER write access to any project, while OWNER stays read-only', async () => {
    const { project } = await setup();
    try {
      const developer = await createTestUser(prisma.client, {
        role: Role.DEVELOPER,
      });
      const owner = await createTestUser(prisma.client, { role: Role.OWNER });
      const devToken = await loginTestUser(
        app.getHttpServer(),
        developer.email,
      );
      const ownerToken = await loginTestUser(app.getHttpServer(), owner.email);
      const body = {
        type: 'INCOME',
        amount: '100.00',
        currency: 'UZS',
        occurredAt: '2026-10-01',
      };

      await post(`/projects/${project.id}/finances`, devToken, body).expect(
        201,
      );
      await post(`/projects/${project.id}/finances`, ownerToken, body).expect(
        403,
      );
      await request(app.getHttpServer())
        .get(`/projects/${project.id}/finances/balance`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });
});
