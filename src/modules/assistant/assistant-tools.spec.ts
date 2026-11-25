import { jest } from '@jest/globals';
import { ForbiddenException } from '@nestjs/common';
import { Role } from '../../generated/prisma/client.js';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { AssistantTools, serialize } from './assistant-tools.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';

function user(role: Role): AuthenticatedUser {
  return {
    id: 'u1',
    email: 'o@x.uz',
    displayName: 'Owner',
    role,
    projectId: null,
    sessionId: 's1',
  };
}

function build() {
  const deps = {
    projects: {
      listForUser: jest
        .fn<(...args: unknown[]) => Promise<unknown>>()
        .mockResolvedValue([{ id: PROJECT, name: 'Plaza 1' }]),
      getForUser: jest
        .fn<(...args: unknown[]) => Promise<unknown>>()
        .mockResolvedValue({ id: PROJECT, name: 'Plaza 1' }),
    },
    projectAccess: {
      assertAccess: jest
        .fn<(...args: unknown[]) => Promise<unknown>>()
        .mockResolvedValue({}),
    },
    analytics: {
      getSummary: jest
        .fn<(...args: unknown[]) => Promise<unknown>>()
        .mockResolvedValue({ ok: true }),
      getMaterials: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
      getConstruction: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    finances: {
      getBalance: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
      list: jest
        .fn<(...args: unknown[]) => Promise<unknown>>()
        .mockResolvedValue({ items: [] }),
    },
    categories: { list: jest.fn<(...args: unknown[]) => Promise<unknown>>() },
    suppliers: { list: jest.fn<(...args: unknown[]) => Promise<unknown>>() },
    supplierLedger: {
      get: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    purchases: { list: jest.fn<(...args: unknown[]) => Promise<unknown>>() },
    inventory: { list: jest.fn<(...args: unknown[]) => Promise<unknown>>() },
  };
  const tools = new AssistantTools(
    deps.projects as never,
    deps.projectAccess as never,
    deps.analytics as never,
    deps.finances as never,
    deps.categories as never,
    deps.suppliers as never,
    deps.supplierLedger as never,
    deps.purchases as never,
    deps.inventory as never,
  );
  return { tools, deps };
}

const validExpense = {
  projectId: PROJECT,
  type: 'EXPENSE',
  amount: '1500000.00',
  currency: 'UZS',
  recipient: 'Бетон ООО',
  occurredAt: '2026-11-20',
};

describe('AssistantTools', () => {
  it('offers the write tool only to OWNER and DEVELOPER', () => {
    const { tools } = build();
    const names = (r: Role) => tools.definitions(user(r)).map((t) => t.name);
    expect(names(Role.OWNER)).toContain('propose_financial_transaction');
    expect(names(Role.DEVELOPER)).toContain('propose_financial_transaction');
    expect(names(Role.ACCOUNTANT)).not.toContain(
      'propose_financial_transaction',
    );
  });

  it('passes the caller through to the service', async () => {
    const { tools, deps } = build();
    const owner = user(Role.OWNER);
    const out = await tools.run(owner, 'get_project_summary', {
      projectId: PROJECT,
      dateFrom: '2026-10-01',
    });
    expect(out.isError).toBe(false);
    expect(deps.analytics.getSummary).toHaveBeenCalledWith(
      owner,
      PROJECT,
      expect.objectContaining({ dateFrom: '2026-10-01' }),
    );
  });

  it('applies the endpoint DTO validation to tool input', async () => {
    const { tools, deps } = build();
    const out = await tools.run(user(Role.OWNER), 'list_transactions', {
      projectId: PROJECT,
      pageSize: 100000,
    });
    expect(out.isError).toBe(true);
    expect(deps.finances.list).not.toHaveBeenCalled();
  });

  it('reports a permission error as a tool error', async () => {
    const { tools, deps } = build();
    deps.analytics.getSummary.mockRejectedValue(
      new ForbiddenException({ code: 'PROJECT_ACCESS_DENIED' }),
    );
    const out = await tools.run(user(Role.OWNER), 'get_project_summary', {
      projectId: PROJECT,
    });
    expect(out).toMatchObject({ isError: true });
    expect(out.content).toContain('403');
  });

  it('prepares a valid expense without writing anything', async () => {
    const { tools, deps } = build();
    const out = await tools.run(
      user(Role.OWNER),
      'propose_financial_transaction',
      validExpense,
    );
    expect(out.isError).toBe(false);
    expect(out.proposal).toMatchObject({
      kind: 'CREATE_FINANCIAL_TRANSACTION',
      projectId: PROJECT,
    });
    expect(out.proposal?.summary).toContain('Расход 1500000.00 UZS');
    expect(deps.projectAccess.assertAccess).toHaveBeenCalled();
  });

  it('refuses a proposal from a read-only role', async () => {
    const { tools } = build();
    const out = await tools.run(
      user(Role.ACCOUNTANT),
      'propose_financial_transaction',
      validExpense,
    );
    expect(out.isError).toBe(true);
    expect(out.proposal).toBeUndefined();
  });

  it('refuses a malformed amount and a SALARY type', async () => {
    const { tools } = build();
    const bad = await tools.run(
      user(Role.OWNER),
      'propose_financial_transaction',
      { ...validExpense, amount: '1,5 млн' },
    );
    expect(bad.isError).toBe(true);
    const salary = await tools.run(
      user(Role.OWNER),
      'propose_financial_transaction',
      { ...validExpense, type: 'SALARY' },
    );
    expect(salary.isError).toBe(true);
  });

  it('truncates very long results', () => {
    const text = serialize({ rows: 'x'.repeat(100_000) });
    expect(text.length).toBeLessThan(41_000);
    expect(text).toContain('truncated');
  });
});
