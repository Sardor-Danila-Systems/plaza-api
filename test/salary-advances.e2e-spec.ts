import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Role } from '../src/generated/prisma/client.js';
import { setupApp } from '../src/setup-app.js';
import {
  createTestProject,
  createTestUser,
  deleteTestProject,
  loginTestUser,
} from './fixtures/auth.fixture.js';

/**
 * Salary advances: employees, advance balance, deduction on payout (accrued /
 * deducted / paid), carry-over, zero-cash payout, cancellations.
 */
describe('Salary advances (e2e)', () => {
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

  async function setup() {
    const project = await createTestProject(
      prisma.client,
      `Adv ${randomUUID()}`,
    );
    const manager = await createTestUser(prisma.client, {
      role: Role.PROJECT_MANAGER,
      projectId: project.id,
    });
    const token = await loginTestUser(app.getHttpServer(), manager.email);
    const http = app.getHttpServer();
    const base = `/projects/${project.id}`;

    const post = (body: Record<string, unknown>) =>
      request(http)
        .post(`${base}/finances`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ currency: 'UZS', occurredAt: '2026-09-14', ...body });
    const cancel = (id: string) =>
      request(http)
        .post(`${base}/finances/${id}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ reason: 'ошибка ввода' });
    const get = (path: string) =>
      request(http)
        .get(`${base}${path}`)
        .set('Authorization', `Bearer ${token}`);

    await post({
      type: 'INCOME',
      amount: '10000000.00',
      source: 'Capital',
    }).expect(201);
    const emp = await request(http)
      .post(`${base}/employees`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Иванов Иван' })
      .expect(201);
    return {
      project,
      token,
      post,
      cancel,
      get,
      employeeId: emp.body.id as string,
    };
  }

  const outstanding = (body: { balances: { outstanding: string }[] }) =>
    body.balances[0]?.outstanding ?? '0.00';

  it('tracks the advance balance and deducts it from a salary payout', async () => {
    const { project, post, get, employeeId } = await setup();
    try {
      const adv = await post({
        type: 'SALARY',
        isAdvance: true,
        employeeId,
        amount: '300000.00',
      }).expect(201);
      expect(adv.body.recipient).toBe('Иванов Иван');

      let list = await get('/employees').expect(200);
      expect(outstanding(list.body[0])).toBe('300000.00');

      const open = await get(`/employees/${employeeId}/open-advances`).expect(
        200,
      );
      expect(open.body).toHaveLength(1);
      expect(open.body[0].remaining).toBe('300000.00');

      // Accrued 1 000 000, deduct 300 000 -> cash out 700 000.
      const payout = await post({
        type: 'SALARY',
        employeeId,
        accruedAmount: '1000000.00',
        amount: '700000.00',
        deductions: [{ advanceId: adv.body.id, amount: '300000.00' }],
      }).expect(201);
      expect(payout.body.accruedAmount).toBe('1000000.00');

      list = await get('/employees').expect(200);
      expect(outstanding(list.body[0])).toBe('0.00');

      // 300 000 (advance) + 700 000 (cash paid) left the till, not 1 300 000.
      const bal = await get('/finances/balance').expect(200);
      expect(bal.body.uzs).toBe('9000000.00');

      const ledger = await get(`/employees/${employeeId}/ledger`).expect(200);
      expect(ledger.body.entries).toHaveLength(2);
      const p = ledger.body.entries.find(
        (e: { kind: string }) => e.kind === 'PAYOUT',
      );
      expect(p.deductions).toEqual([
        { advanceId: adv.body.id, amount: '300000.00' },
      ]);
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });

  it('supports partial deduction and carries the rest to the next payout', async () => {
    const { project, post, get, employeeId } = await setup();
    try {
      const adv = await post({
        type: 'SALARY',
        isAdvance: true,
        employeeId,
        amount: '500000.00',
      }).expect(201);
      await post({
        type: 'SALARY',
        employeeId,
        accruedAmount: '800000.00',
        amount: '600000.00',
        deductions: [{ advanceId: adv.body.id, amount: '200000.00' }],
      }).expect(201);
      let list = await get('/employees').expect(200);
      expect(outstanding(list.body[0])).toBe('300000.00');

      // Over-deducting what is left is rejected.
      await post({
        type: 'SALARY',
        employeeId,
        accruedAmount: '800000.00',
        amount: '400000.00',
        deductions: [{ advanceId: adv.body.id, amount: '400000.00' }],
      }).expect(409);

      await post({
        type: 'SALARY',
        employeeId,
        accruedAmount: '800000.00',
        amount: '500000.00',
        deductions: [{ advanceId: adv.body.id, amount: '300000.00' }],
      }).expect(201);
      list = await get('/employees').expect(200);
      expect(outstanding(list.body[0])).toBe('0.00');
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });

  it('allows a zero-cash payout only when advances cover the salary', async () => {
    const { project, post, cancel, get, employeeId } = await setup();
    try {
      const adv = await post({
        type: 'SALARY',
        isAdvance: true,
        employeeId,
        amount: '900000.00',
      }).expect(201);

      const zero = await post({
        type: 'SALARY',
        employeeId,
        accruedAmount: '600000.00',
        amount: '0.00',
        deductions: [{ advanceId: adv.body.id, amount: '600000.00' }],
      }).expect(201);
      expect(zero.body.amount).toBe('0.00');
      let list = await get('/employees').expect(200);
      expect(outstanding(list.body[0])).toBe('300000.00');

      // Zero everywhere else is still rejected.
      await post({ type: 'EXPENSE', amount: '0.00', recipient: 'x' }).expect(
        400,
      );
      await post({
        type: 'SALARY',
        isAdvance: true,
        employeeId,
        amount: '0.00',
      }).expect(400);
      await post({ type: 'SALARY', employeeId, amount: '0.00' }).expect(400);

      // Cancelling the zero payout releases the advance.
      await cancel(zero.body.id).expect(200);
      list = await get('/employees').expect(200);
      expect(outstanding(list.body[0])).toBe('900000.00');
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });

  it('rejects inconsistent accrued/deducted/paid and foreign advances', async () => {
    const { project, post, employeeId, token } = await setup();
    try {
      const adv = await post({
        type: 'SALARY',
        isAdvance: true,
        employeeId,
        amount: '100000.00',
      }).expect(201);
      // accrued != paid + deducted
      await post({
        type: 'SALARY',
        employeeId,
        accruedAmount: '500000.00',
        amount: '300000.00',
        deductions: [{ advanceId: adv.body.id, amount: '100000.00' }],
      }).expect(400);
      // deduction without accrued
      await post({
        type: 'SALARY',
        employeeId,
        amount: '300000.00',
        deductions: [{ advanceId: adv.body.id, amount: '100000.00' }],
      }).expect(400);
      // advance of another employee
      const other = await request(app.getHttpServer())
        .post(`/projects/${project.id}/employees`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Петров' })
        .expect(201);
      await post({
        type: 'SALARY',
        employeeId: other.body.id,
        accruedAmount: '300000.00',
        amount: '200000.00',
        deductions: [{ advanceId: adv.body.id, amount: '100000.00' }],
      }).expect(400);
      // SALARY needs an employee; deductions are SALARY-only
      await post({ type: 'SALARY', amount: '1000.00', recipient: 'x' }).expect(
        400,
      );
      await post({
        type: 'EXPENSE',
        amount: '1000.00',
        recipient: 'x',
        employeeId,
      }).expect(400);
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });

  it('blocks cancelling a deducted advance until the salary is cancelled', async () => {
    const { project, post, cancel, get, employeeId } = await setup();
    try {
      const free = await post({
        type: 'SALARY',
        isAdvance: true,
        employeeId,
        amount: '50000.00',
      }).expect(201);
      // Not deducted: cancels like any operation.
      await cancel(free.body.id).expect(200);

      const adv = await post({
        type: 'SALARY',
        isAdvance: true,
        employeeId,
        amount: '200000.00',
      }).expect(201);
      const payout = await post({
        type: 'SALARY',
        employeeId,
        accruedAmount: '700000.00',
        amount: '500000.00',
        deductions: [{ advanceId: adv.body.id, amount: '200000.00' }],
      }).expect(201);

      const blocked = await cancel(adv.body.id).expect(409);
      expect(blocked.body.code ?? blocked.body.error?.code).toBe(
        'ADVANCE_ALREADY_DEDUCTED',
      );

      await cancel(payout.body.id).expect(200);
      let list = await get('/employees').expect(200);
      expect(outstanding(list.body[0])).toBe('200000.00');

      await cancel(adv.body.id).expect(200);
      list = await get('/employees').expect(200);
      expect(outstanding(list.body[0])).toBe('0.00');
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });

  it('counts advances plus cash paid exactly once in the salary analytics', async () => {
    const { project, post, get, employeeId } = await setup();
    try {
      const adv = await post({
        type: 'SALARY',
        isAdvance: true,
        employeeId,
        amount: '300000.00',
      }).expect(201);
      await post({
        type: 'SALARY',
        employeeId,
        accruedAmount: '1000000.00',
        amount: '700000.00',
        deductions: [{ advanceId: adv.body.id, amount: '300000.00' }],
      }).expect(201);
      const res = await get(
        '/analytics/summary?dateFrom=2026-09-01&dateTo=2026-10-01',
      ).expect(200);
      expect(res.body.salariesUzs).toBe('1000000.00');
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });

  it('exports the employee ledger to Excel', async () => {
    const { project, post, employeeId, token } = await setup();
    try {
      const adv = await post({
        type: 'SALARY',
        isAdvance: true,
        employeeId,
        amount: '300000.00',
      }).expect(201);
      await post({
        type: 'SALARY',
        employeeId,
        accruedAmount: '1000000.00',
        amount: '700000.00',
        deductions: [{ advanceId: adv.body.id, amount: '300000.00' }],
      }).expect(201);
      const res = await request(app.getHttpServer())
        .get(
          `/projects/${project.id}/reports/employee-ledger.xlsx?employeeId=${employeeId}&dateFrom=2026-01-01&dateTo=2026-12-31`,
        )
        .set('Authorization', `Bearer ${token}`)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.headers['content-type']).toContain('spreadsheetml');
      // xlsx is a zip: starts with PK
      expect((res.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    } finally {
      await deleteTestProject(prisma.client, project.id);
    }
  });
});
