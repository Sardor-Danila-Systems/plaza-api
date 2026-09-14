import { jest } from '@jest/globals';
import { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from './audit.service.js';

interface CreateCallArgs {
  data: {
    projectId: string;
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    operationId?: string;
    requestId?: string;
    previousData: unknown;
    newData: unknown;
  };
}

function fakeTx(): {
  auditLog: { create: jest.Mock<(args: CreateCallArgs) => Promise<void>> };
} {
  return {
    auditLog: {
      create: jest.fn((_args: CreateCallArgs) => Promise.resolve()),
    },
  };
}

function lastCallArgs(tx: ReturnType<typeof fakeTx>): CreateCallArgs['data'] {
  const calls = tx.auditLog.create.mock.calls as unknown as [CreateCallArgs][];
  return calls[0][0].data;
}

describe('AuditService', () => {
  it('writes previousData as Prisma.JsonNull for a creation (no previousData given)', async () => {
    const tx = fakeTx();
    const service = new AuditService();

    await service.record(tx as never, {
      projectId: 'p1',
      actorId: 'u1',
      action: 'financial_transaction.create',
      entityType: 'FinancialTransaction',
      entityId: 'ft1',
      newData: { amount: '100.00' },
    });

    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const data = lastCallArgs(tx);
    expect(data.previousData).toBe(Prisma.JsonNull);
    expect(data.newData).toEqual({ amount: '100.00' });
  });

  it('JSON-round-trips previousData/newData, stringifying Decimal/Date values', async () => {
    const tx = fakeTx();
    const service = new AuditService();
    const occurredAt = new Date('2026-09-14T00:00:00.000Z');

    await service.record(tx as never, {
      projectId: 'p1',
      actorId: 'u1',
      action: 'financial_transaction.cancel',
      entityType: 'FinancialTransaction',
      entityId: 'ft1',
      previousData: {
        amount: new Prisma.Decimal('100.00'),
        cancelledAt: null,
      },
      newData: { amount: new Prisma.Decimal('100.00'), occurredAt },
    });

    const data = lastCallArgs(tx);
    expect(data.previousData).toEqual({ amount: '100', cancelledAt: null });
    expect(data.newData).toEqual({
      amount: '100',
      occurredAt: occurredAt.toISOString(),
    });
  });

  it('drops undefined properties from snapshots', async () => {
    const tx = fakeTx();
    const service = new AuditService();

    await service.record(tx as never, {
      projectId: 'p1',
      actorId: 'u1',
      action: 'financial_transaction.create',
      entityType: 'FinancialTransaction',
      entityId: 'ft1',
      newData: { comment: undefined, amount: '5.00' },
    });

    const data = lastCallArgs(tx);
    expect(data.newData).toEqual({ amount: '5.00' });
    expect(data.newData as object).not.toHaveProperty('comment');
  });

  it('passes operationId and requestId through when provided', async () => {
    const tx = fakeTx();
    const service = new AuditService();

    await service.record(tx as never, {
      projectId: 'p1',
      actorId: 'u1',
      action: 'financial_transaction.create',
      entityType: 'FinancialTransaction',
      entityId: 'ft1',
      operationId: 'op1',
      requestId: 'req1',
      newData: {},
    });

    const data = lastCallArgs(tx);
    expect(data.operationId).toBe('op1');
    expect(data.requestId).toBe('req1');
  });
});
