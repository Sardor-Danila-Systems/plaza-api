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
  deleteTestUser,
  loginTestUser,
} from './fixtures/auth.fixture.js';

/** Buffers the raw response body regardless of Content-Type — supertest has
 * no built-in parser for XLSX's MIME type. */
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
  // Cast: exceljs's own `Buffer` type parameter resolves against a
  // slightly different structural shape than this project's `@types/node`
  // Buffer in strict mode — a pure type-level mismatch, not a runtime one
  // (this is the exact Buffer supertest/Node handed us).
  await workbook.xlsx.load(
    buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
  );
  return workbook;
}

describe('XLSX reports (e2e)', () => {
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

  function idem(): string {
    return randomUUID();
  }

  async function setupProjectAndManager() {
    const project = await createTestProject(
      prisma.client,
      `Reports Test ${randomUUID()}`,
    );
    const manager = await createTestUser(prisma.client, {
      role: Role.PROJECT_MANAGER,
      projectId: project.id,
    });
    const token = await loginTestUser(app.getHttpServer(), manager.email);
    return { project, manager, token };
  }

  it('exports a valid cash-ledger.xlsx with a frozen header row, exact decimal text cells, and formula-injection protection', async () => {
    const { project, token } = await setupProjectAndManager();
    try {
      await request(app.getHttpServer())
        .post(`/projects/${project.id}/finances`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idem())
        .send({
          type: 'INCOME',
          amount: '1234567.89',
          currency: 'UZS',
          source: "=CMD('calc')!A1", // classic formula-injection payload
          occurredAt: '2026-09-14',
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(`/projects/${project.id}/reports/cash.xlsx`)
        .set('Authorization', `Bearer ${token}`)
        .buffer(true)
        .parse(bufferParser)
        .expect(200);

      expect(res.headers['content-type']).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      expect(res.headers['content-disposition']).toContain('cash-ledger.xlsx');
      expect(res.headers['x-content-type-options']).toBe('nosniff');

      const workbook = await loadWorkbook(res.body as Buffer);
      const sheet = workbook.getWorksheet('Cash Ledger')!;
      expect(sheet).toBeDefined();
      expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });

      const headerRow = sheet.getRow(1).values as unknown[];
      expect(headerRow).toContain('Amount (UZS)');
      expect(headerRow).toContain('Recipient / Source');

      const dataRow = sheet.getRow(2);
      // Exact decimal string, not a JS-float-rounded number.
      expect(dataRow.getCell(4).value).toBe('1234567.89');
      expect(typeof dataRow.getCell(4).value).toBe('string');
      expect(dataRow.getCell(7).value).toBe('1234567.89');

      // The injected "=CMD(...)" payload must never survive as a live
      // formula cell — it is defused with a leading apostrophe and stored
      // as plain text.
      const sourceCell = dataRow.getCell(9);
      expect(typeof sourceCell.value).toBe('string');
      expect(String(sourceCell.value).startsWith("'=")).toBe(true);
      expect(sourceCell.formula).toBeUndefined();
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });

  it('exports purchases.xlsx with a Purchases sheet and an Items sheet', async () => {
    const { project, token } = await setupProjectAndManager();
    try {
      const category = await prisma.client.materialCategory.create({
        data: { projectId: project.id, name: 'Cat' },
      });
      const unit = await prisma.client.unit.create({
        data: { projectId: project.id, symbol: 'kg', name: 'Kilogram' },
      });
      const warehouse = await prisma.client.warehouse.create({
        data: {
          projectId: project.id,
          name: 'WH1',
          code: `wh-${randomUUID()}`,
        },
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
      const supplier = await createTestSupplier(prisma.client, project.id);

      await request(app.getHttpServer())
        .post(`/projects/${project.id}/purchases`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idem())
        .send({
          supplierId: supplier.id,
          warehouseId: warehouse.id,
          currency: 'UZS',
          items: [
            {
              materialId: material.id,
              quantity: '10.000000',
              unitPrice: '1000.00000000',
            },
          ],
          invoiceNumber: 'INV-001',
          occurredAt: '2026-09-14',
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(`/projects/${project.id}/reports/purchases.xlsx`)
        .set('Authorization', `Bearer ${token}`)
        .buffer(true)
        .parse(bufferParser)
        .expect(200);

      const workbook = await loadWorkbook(res.body as Buffer);
      const purchasesSheet = workbook.getWorksheet('Purchases')!;
      const itemsSheet = workbook.getWorksheet('Items')!;
      expect(purchasesSheet.getRow(2).getCell(2).value).toBe('INV-001');
      expect(itemsSheet.getRow(2).getCell(5).value).toBe('Cement');
      expect(itemsSheet.getRow(2).getCell(6).value).toBe('10.000000');
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });

  it('produces an empty (header-only) sheet for a project with no activity, rather than erroring', async () => {
    const { project, token } = await setupProjectAndManager();
    try {
      const res = await request(app.getHttpServer())
        .get(`/projects/${project.id}/reports/inventory.xlsx`)
        .set('Authorization', `Bearer ${token}`)
        .buffer(true)
        .parse(bufferParser)
        .expect(200);
      const workbook = await loadWorkbook(res.body as Buffer);
      const sheet = workbook.getWorksheet('Inventory Balances')!;
      expect(sheet.rowCount).toBe(1); // header only
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });

  describe('Authorization', () => {
    it('OWNER/ACCOUNTANT can export; a manager of a different project cannot', async () => {
      const { project } = await setupProjectAndManager();
      const other = await setupProjectAndManager();
      const owner = await createTestUser(prisma.client, { role: Role.OWNER });
      try {
        const ownerToken = await loginTestUser(
          app.getHttpServer(),
          owner.email,
        );
        await request(app.getHttpServer())
          .get(`/projects/${project.id}/reports/cash.xlsx`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .buffer(true)
          .parse(bufferParser)
          .expect(200);
        await request(app.getHttpServer())
          .get(`/projects/${project.id}/reports/cash.xlsx`)
          .set('Authorization', `Bearer ${other.token}`)
          .expect(403);
      } finally {
        await deleteTestUser(prisma.client, owner.id);
        await deleteTestProject(prisma.client, project.id);
        await deleteTestProject(prisma.client, other.project.id);
      }
    });
  });
});
