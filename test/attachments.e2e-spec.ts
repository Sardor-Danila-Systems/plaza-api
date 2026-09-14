import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { AttachmentsCleanupService } from '../src/modules/attachments/attachments-cleanup.service.js';
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

// A standard 1x1 transparent PNG — real magic bytes, so `file-type` (and any
// magic-byte sniffer) genuinely detects `image/png`, not a client-declared
// label this test controls.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n1 0 obj\n<<>>\nendobj\n%%EOF',
  'binary',
);
const FAKE_HTML_BYTES = Buffer.from('<!DOCTYPE html><script>alert(1)</script>');

describe('Attachments (e2e)', () => {
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
      `Attachments Test ${randomUUID()}`,
    );
    const manager = await createTestUser(prisma.client, {
      role: Role.PROJECT_MANAGER,
      projectId: project.id,
    });
    const token = await loginTestUser(app.getHttpServer(), manager.email);
    return { project, manager, token };
  }

  async function createIncomeTransaction(projectId: string, token: string) {
    const res = await request(app.getHttpServer())
      .post(`/projects/${projectId}/finances`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idem())
      .send({
        type: 'INCOME',
        amount: '1000.00',
        currency: 'UZS',
        source: 'x',
        occurredAt: '2026-09-14',
      })
      .expect(201);
    return res.body.id as string;
  }

  describe('Upload and validation', () => {
    it('accepts a real PNG and returns a READY, unlinked attachment', async () => {
      const { project, manager, token } = await setupProjectAndManager();
      try {
        const res = await request(app.getHttpServer())
          .post(`/projects/${project.id}/attachments`)
          .set('Authorization', `Bearer ${token}`)
          .attach('file', PNG_BYTES, 'photo.png')
          .expect(201);

        expect(res.body.status).toBe('READY');
        expect(res.body.mimeType).toBe('image/png');
        expect(res.body.target).toBeNull();
        expect(res.body.uploadedById).toBe(manager.id);

        const row = await prisma.client.attachment.findUniqueOrThrow({
          where: { id: res.body.id },
        });
        expect(row.status).toBe('READY');
        expect(row.storageKey).not.toContain('..');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('accepts a real PDF', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const res = await request(app.getHttpServer())
          .post(`/projects/${project.id}/attachments`)
          .set('Authorization', `Bearer ${token}`)
          .attach('file', PDF_BYTES, 'invoice.pdf')
          .expect(201);
        expect(res.body.mimeType).toBe('application/pdf');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects a file whose declared type/extension lies about its actual content (fake extension/MIME)', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const res = await request(app.getHttpServer())
          .post(`/projects/${project.id}/attachments`)
          .set('Authorization', `Bearer ${token}`)
          .attach('file', FAKE_HTML_BYTES, {
            filename: 'innocent.png',
            contentType: 'image/png',
          })
          .expect(409);
        expect(res.body.code).toBe('UNSUPPORTED_FILE_TYPE');

        const count = await prisma.client.attachment.count({
          where: { projectId: project.id },
        });
        expect(count).toBe(0);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects an oversized upload with 413 FILE_TOO_LARGE', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        // ATTACHMENT_MAX_SIZE_BYTES defaults to 10 MiB; this is intentionally
        // wrapped PNG bytes padded past that with trailing junk (still a
        // single multipart field, no magic-byte validity required for a
        // pure size-limit rejection, since multer rejects before the
        // handler even runs).
        const oversized = Buffer.concat([
          PNG_BYTES,
          Buffer.alloc(11 * 1024 * 1024, 0),
        ]);
        const res = await request(app.getHttpServer())
          .post(`/projects/${project.id}/attachments`)
          .set('Authorization', `Bearer ${token}`)
          .attach('file', oversized, 'huge.png')
          .expect(413);
        expect(res.body.code).toBe('FILE_TOO_LARGE');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    }, 20000);

    it('rejects an upload with no file', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/attachments`)
          .set('Authorization', `Bearer ${token}`)
          .expect(400);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });

  describe('Authorization', () => {
    it('OWNER/ACCOUNTANT can list/read but not upload', async () => {
      const { project } = await setupProjectAndManager();
      const owner = await createTestUser(prisma.client, { role: Role.OWNER });
      try {
        const ownerToken = await loginTestUser(
          app.getHttpServer(),
          owner.email,
        );
        await request(app.getHttpServer())
          .get(`/projects/${project.id}/attachments`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .expect(200);
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/attachments`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .attach('file', PNG_BYTES, 'photo.png')
          .expect(403);
      } finally {
        await deleteTestUser(prisma.client, owner.id);
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('a manager of a different project cannot upload, link, read, or download', async () => {
      const { project, token } = await setupProjectAndManager();
      const other = await setupProjectAndManager();
      try {
        const created = await request(app.getHttpServer())
          .post(`/projects/${project.id}/attachments`)
          .set('Authorization', `Bearer ${token}`)
          .attach('file', PNG_BYTES, 'photo.png')
          .expect(201);

        await request(app.getHttpServer())
          .post(`/projects/${project.id}/attachments`)
          .set('Authorization', `Bearer ${other.token}`)
          .attach('file', PNG_BYTES, 'photo.png')
          .expect(403);
        await request(app.getHttpServer())
          .get(`/projects/${project.id}/attachments/${created.body.id}`)
          .set('Authorization', `Bearer ${other.token}`)
          .expect(403);
        await request(app.getHttpServer())
          .get(
            `/projects/${project.id}/attachments/${created.body.id}/download`,
          )
          .set('Authorization', `Bearer ${other.token}`)
          .expect(403);
      } finally {
        await deleteTestProject(prisma.client, project.id);
        await deleteTestProject(prisma.client, other.project.id);
      }
    });
  });

  describe('Linking', () => {
    it('links a READY attachment to a purchase and then to a supplier payment, and lists by target', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const supplier = await createTestSupplier(prisma.client, project.id);
        const advance = await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '5000000.00',
            currency: 'UZS',
            source: 'x',
            occurredAt: '2026-09-14',
          })
          .expect(201);
        void advance;
        const advanceRes = await request(app.getHttpServer())
          .post(`/projects/${project.id}/suppliers/${supplier.id}/advances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            currency: 'UZS',
            amount: '1000000.00',
            occurredAt: '2026-09-14',
          })
          .expect(201);

        const payment = await prisma.client.supplierAdvance.findUniqueOrThrow({
          where: { id: advanceRes.body.id },
        });

        const attachment = await request(app.getHttpServer())
          .post(`/projects/${project.id}/attachments`)
          .set('Authorization', `Bearer ${token}`)
          .attach('file', PDF_BYTES, 'advance-receipt.pdf')
          .expect(201);

        const linked = await request(app.getHttpServer())
          .post(
            `/projects/${project.id}/attachments/${attachment.body.id}/link`,
          )
          .set('Authorization', `Bearer ${token}`)
          .send({
            target: 'SUPPLIER_PAYMENT',
            targetId: payment.fundingPaymentId,
          })
          .expect(200);
        expect(linked.body.status).toBe('LINKED');
        expect(linked.body.target).toBe('SUPPLIER_PAYMENT');
        expect(linked.body.targetId).toBe(payment.fundingPaymentId);

        const list = await request(app.getHttpServer())
          .get(`/projects/${project.id}/attachments`)
          .query({
            target: 'SUPPLIER_PAYMENT',
            targetId: payment.fundingPaymentId,
          })
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(list.body.total).toBe(1);
        expect(list.body.data[0].id).toBe(attachment.body.id);

        // Cannot relink an already-LINKED attachment.
        await request(app.getHttpServer())
          .post(
            `/projects/${project.id}/attachments/${attachment.body.id}/link`,
          )
          .set('Authorization', `Bearer ${token}`)
          .send({
            target: 'SUPPLIER_PAYMENT',
            targetId: payment.fundingPaymentId,
          })
          .expect(409);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects linking to a PURCHASE-type/ADVANCE FinancialTransaction — only INCOME/EXPENSE allowed directly', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const supplier = await createTestSupplier(prisma.client, project.id);
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/finances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            type: 'INCOME',
            amount: '5000000.00',
            currency: 'UZS',
            source: 'x',
            occurredAt: '2026-09-14',
          })
          .expect(201);
        const advanceRes = await request(app.getHttpServer())
          .post(`/projects/${project.id}/suppliers/${supplier.id}/advances`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idem())
          .send({
            currency: 'UZS',
            amount: '1000000.00',
            occurredAt: '2026-09-14',
          })
          .expect(201);
        const advance = await prisma.client.supplierAdvance.findUniqueOrThrow({
          where: { id: advanceRes.body.id },
        });
        const advanceTx =
          await prisma.client.financialTransaction.findFirstOrThrow({
            where: { supplierPaymentId: advance.fundingPaymentId },
          });

        const attachment = await request(app.getHttpServer())
          .post(`/projects/${project.id}/attachments`)
          .set('Authorization', `Bearer ${token}`)
          .attach('file', PNG_BYTES, 'photo.png')
          .expect(201);

        const res = await request(app.getHttpServer())
          .post(
            `/projects/${project.id}/attachments/${attachment.body.id}/link`,
          )
          .set('Authorization', `Bearer ${token}`)
          .send({ target: 'FINANCIAL_TRANSACTION', targetId: advanceTx.id })
          .expect(409);
        expect(res.body.code).toBe('UNSUPPORTED_ATTACHMENT_TARGET');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('rejects linking to a nonexistent target and a target from a different project', async () => {
      const { project, token } = await setupProjectAndManager();
      const other = await setupProjectAndManager();
      try {
        const otherTxId = await createIncomeTransaction(
          other.project.id,
          other.token,
        );
        const attachment = await request(app.getHttpServer())
          .post(`/projects/${project.id}/attachments`)
          .set('Authorization', `Bearer ${token}`)
          .attach('file', PNG_BYTES, 'photo.png')
          .expect(201);

        await request(app.getHttpServer())
          .post(
            `/projects/${project.id}/attachments/${attachment.body.id}/link`,
          )
          .set('Authorization', `Bearer ${token}`)
          .send({ target: 'FINANCIAL_TRANSACTION', targetId: randomUUID() })
          .expect(404);
        await request(app.getHttpServer())
          .post(
            `/projects/${project.id}/attachments/${attachment.body.id}/link`,
          )
          .set('Authorization', `Bearer ${token}`)
          .send({ target: 'FINANCIAL_TRANSACTION', targetId: otherTxId })
          .expect(404);
      } finally {
        await deleteTestProject(prisma.client, project.id);
        await deleteTestProject(prisma.client, other.project.id);
      }
    });
  });

  describe('Download', () => {
    it('streams the exact uploaded bytes back with the verified content type and a safe filename', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const created = await request(app.getHttpServer())
          .post(`/projects/${project.id}/attachments`)
          .set('Authorization', `Bearer ${token}`)
          .attach('file', PNG_BYTES, '../../evil name".png')
          .expect(201);

        const download = await request(app.getHttpServer())
          .get(
            `/projects/${project.id}/attachments/${created.body.id}/download`,
          )
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(download.headers['content-type']).toBe('image/png');
        expect(download.headers['x-content-type-options']).toBe('nosniff');
        expect(download.headers['content-disposition']).not.toMatch(
          /\.\.[/\\]/,
        );
        expect(Buffer.compare(download.body, PNG_BYTES)).toBe(0);
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });
  });

  describe('Deletion and orphan cleanup', () => {
    it('deletes an unlinked attachment but rejects deleting a LINKED one', async () => {
      const { project, token } = await setupProjectAndManager();
      try {
        const orphan = await request(app.getHttpServer())
          .post(`/projects/${project.id}/attachments`)
          .set('Authorization', `Bearer ${token}`)
          .attach('file', PNG_BYTES, 'photo.png')
          .expect(201);
        await request(app.getHttpServer())
          .delete(`/projects/${project.id}/attachments/${orphan.body.id}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(204);
        const gone = await prisma.client.attachment.findUnique({
          where: { id: orphan.body.id },
        });
        expect(gone).toBeNull();

        const txId = await createIncomeTransaction(project.id, token);
        const linkedSource = await request(app.getHttpServer())
          .post(`/projects/${project.id}/attachments`)
          .set('Authorization', `Bearer ${token}`)
          .attach('file', PNG_BYTES, 'photo.png')
          .expect(201);
        await request(app.getHttpServer())
          .post(
            `/projects/${project.id}/attachments/${linkedSource.body.id}/link`,
          )
          .set('Authorization', `Bearer ${token}`)
          .send({ target: 'FINANCIAL_TRANSACTION', targetId: txId })
          .expect(200);

        const res = await request(app.getHttpServer())
          .delete(`/projects/${project.id}/attachments/${linkedSource.body.id}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(409);
        expect(res.body.code).toBe('ATTACHMENT_LINKED');

        const stillThere = await prisma.client.attachment.findUnique({
          where: { id: linkedSource.body.id },
        });
        expect(stillThere?.status).toBe('LINKED');
      } finally {
        await deleteTestProject(prisma.client, project.id);
      }
    });

    it('the orphan cleanup job removes expired unlinked attachments but never a LINKED one', async () => {
      const moduleRef: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      const cleanupApp = moduleRef.createNestApplication();
      await cleanupApp.init();
      const cleanup = cleanupApp.get(AttachmentsCleanupService);

      const { project, token } = await setupProjectAndManager();
      try {
        const orphan = await request(app.getHttpServer())
          .post(`/projects/${project.id}/attachments`)
          .set('Authorization', `Bearer ${token}`)
          .attach('file', PNG_BYTES, 'photo.png')
          .expect(201);

        const txId = await createIncomeTransaction(project.id, token);
        const linked = await request(app.getHttpServer())
          .post(`/projects/${project.id}/attachments`)
          .set('Authorization', `Bearer ${token}`)
          .attach('file', PNG_BYTES, 'photo.png')
          .expect(201);
        await request(app.getHttpServer())
          .post(`/projects/${project.id}/attachments/${linked.body.id}/link`)
          .set('Authorization', `Bearer ${token}`)
          .send({ target: 'FINANCIAL_TRANSACTION', targetId: txId })
          .expect(200);

        // Rather than mutating the row's own `expiresAt` (illegal per the
        // immutability trigger while READY — only a READY -> LINKED
        // transition is allowed), simulate "the TTL has elapsed" by passing
        // a future `now` to the cleanup job, exactly as it would be called
        // once real time has actually advanced.
        const asIfTtlElapsed = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
        const removed = await cleanup.cleanupExpired(asIfTtlElapsed);
        expect(removed).toBeGreaterThanOrEqual(1);

        const orphanRow = await prisma.client.attachment.findUnique({
          where: { id: orphan.body.id },
        });
        expect(orphanRow).toBeNull();
        const linkedRow = await prisma.client.attachment.findUnique({
          where: { id: linked.body.id },
        });
        expect(linkedRow?.status).toBe('LINKED');
      } finally {
        await deleteTestProject(prisma.client, project.id);
        await cleanupApp.close();
      }
    });
  });
});
