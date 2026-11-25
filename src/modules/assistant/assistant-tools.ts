import { HttpException, Injectable } from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Role } from '../../generated/prisma/client.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { AnalyticsPeriodQueryDto } from '../analytics/dto/analytics-period-query.dto.js';
import { ConstructionAnalyticsQueryDto } from '../analytics/dto/construction-analytics-query.dto.js';
import { MaterialsAnalyticsQueryDto } from '../analytics/dto/materials-analytics-query.dto.js';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { TransactionCategoriesService } from '../finances/categories/transaction-categories.service.js';
import { CreateFinancialTransactionDto } from '../finances/dto/create-financial-transaction.dto.js';
import { ListFinancialTransactionsQueryDto } from '../finances/dto/list-financial-transactions-query.dto.js';
import { FinancialPostingService } from '../finances/financial-posting.service.js';
import { InventoryBalancesService } from '../inventory/balances/inventory-balances.service.js';
import { ListInventoryQueryDto } from '../inventory/balances/dto/list-inventory-query.dto.js';
import { ProjectAccessAction } from '../projects/project-access-action.enum.js';
import { ProjectAccessArea } from '../projects/project-access-area.enum.js';
import { ProjectAccessService } from '../projects/project-access.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ListPurchasesQueryDto } from '../purchases/dto/list-purchases-query.dto.js';
import { PurchasesService } from '../purchases/purchases.service.js';
import { ListSuppliersQueryDto } from '../suppliers/dto/list-suppliers-query.dto.js';
import { SupplierLedgerService } from '../suppliers/ledger/supplier-ledger.service.js';
import { SuppliersService } from '../suppliers/suppliers.service.js';

/** Roles that may ask the assistant to prepare a write. */
export const WRITER_ROLES: readonly Role[] = [Role.OWNER, Role.DEVELOPER];

/** A tool result longer than this is cut, so one wide list cannot fill the context. */
const MAX_RESULT_CHARS = 40_000;

/** What a proposal tool hands back to the service, which signs it. */
export interface ProposedWrite {
  kind: 'CREATE_FINANCIAL_TRANSACTION';
  projectId: string;
  payload: Record<string, unknown>;
  summary: string;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
  proposal?: ProposedWrite;
}

const uuid = { type: 'string', format: 'uuid' } as const;
const date = { type: 'string', description: 'YYYY-MM-DD' } as const;
const projectId = {
  ...uuid,
  description: 'Project id from list_projects',
} as const;
const period = {
  dateFrom: {
    ...date,
    description: 'Start of the period, inclusive (YYYY-MM-DD)',
  },
  dateTo: { ...date, description: 'End of the period, EXCLUSIVE (YYYY-MM-DD)' },
} as const;

function schema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Anthropic.Tool.InputSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

const READ_TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_projects',
    description:
      'Lists every construction project the user can see, with its id, name, code and manager. Call this first to learn project ids.',
    input_schema: schema({}),
  },
  {
    name: 'get_project_summary',
    description:
      'Totals for one project over a period: cash in and out, expenses, purchases, supplier debt and advances, inventory value. Omit the dates for all time.',
    input_schema: schema({ projectId, ...period }, ['projectId']),
  },
  {
    name: 'get_cash_balance',
    description:
      'Current cash balance of one project, per currency and account (cash / bank).',
    input_schema: schema({ projectId }, ['projectId']),
  },
  {
    name: 'list_transactions',
    description:
      'Cash ledger entries of one project (income, expense, salary, supplier payments), newest first, paginated.',
    input_schema: schema(
      {
        projectId,
        ...period,
        type: {
          type: 'string',
          enum: [
            'INCOME',
            'EXPENSE',
            'SALARY',
            'PURCHASE',
            'ADVANCE',
            'DEBT_PAYMENT',
            'REFUND',
            'ADJUSTMENT',
          ],
        },
        categoryId: uuid,
        currency: { type: 'string', enum: ['UZS', 'USD'] },
        page: { type: 'integer', minimum: 1 },
        pageSize: { type: 'integer', minimum: 1, maximum: 100 },
      },
      ['projectId'],
    ),
  },
  {
    name: 'list_transaction_categories',
    description: 'Income and expense categories of one project, with ids.',
    input_schema: schema({ projectId }, ['projectId']),
  },
  {
    name: 'list_suppliers',
    description:
      'Suppliers of one project; search matches name, contact, phone or taxpayer id.',
    input_schema: schema({ projectId, search: { type: 'string' } }, [
      'projectId',
    ]),
  },
  {
    name: 'get_supplier_ledger',
    description:
      "One supplier's purchases, payments, advances and the resulting debt or advance balance.",
    input_schema: schema({ projectId, supplierId: uuid }, [
      'projectId',
      'supplierId',
    ]),
  },
  {
    name: 'list_purchases',
    description:
      'Supplier invoices of one project with their items and payment state.',
    input_schema: schema(
      { projectId, supplierId: uuid, warehouseId: uuid, ...period },
      ['projectId'],
    ),
  },
  {
    name: 'get_inventory',
    description:
      'Material balances in the warehouses of one project: quantity, unit, average cost, value. lowStock=true returns only materials below their minimum.',
    input_schema: schema(
      {
        projectId,
        warehouseId: uuid,
        search: { type: 'string' },
        lowStock: { type: 'boolean' },
      },
      ['projectId'],
    ),
  },
  {
    name: 'get_materials_analytics',
    description:
      'Per material: quantity and value purchased and consumed over a period.',
    input_schema: schema({ projectId, ...period, materialId: uuid }, [
      'projectId',
    ]),
  },
  {
    name: 'get_construction_analytics',
    description:
      'Material consumption by building block and floor over a period.',
    input_schema: schema(
      { projectId, ...period, blockId: uuid, floorId: uuid },
      ['projectId'],
    ),
  },
];

const WRITE_TOOLS: Anthropic.Tool[] = [
  {
    name: 'propose_financial_transaction',
    description:
      "Prepares an INCOME or EXPENSE entry in a project's cash ledger. Nothing is written: the owner sees the proposal as a card and confirms or rejects it. Use only when the owner clearly asked to record money. Look up the categoryId with list_transaction_categories first.",
    input_schema: schema(
      {
        projectId,
        type: { type: 'string', enum: ['INCOME', 'EXPENSE'] },
        amount: {
          type: 'string',
          description:
            'Positive decimal, at most 2 fractional digits, e.g. "1500000.00"',
        },
        currency: { type: 'string', enum: ['UZS', 'USD'] },
        account: {
          type: 'string',
          enum: ['CASH', 'BANK'],
          description: 'Наличные or Банк; default CASH',
        },
        categoryId: uuid,
        source: {
          type: 'string',
          description: 'Who the income came from (INCOME)',
        },
        recipient: { type: 'string', description: 'Who was paid (EXPENSE)' },
        comment: { type: 'string' },
        occurredAt: { ...date, description: 'Business date, YYYY-MM-DD' },
        exchangeRate: {
          type: 'string',
          description:
            'UZS per 1 USD; only for USD when the owner named a rate',
        },
        rateOverrideReason: {
          type: 'string',
          description: 'Required together with exchangeRate',
        },
      },
      ['projectId', 'type', 'amount', 'currency', 'occurredAt'],
    ),
  },
];

class ToolInputError extends Error {}

/** Same class-validator rules an HTTP request to the equivalent endpoint gets. */
function parse<T extends object>(
  cls: ClassConstructor<T>,
  input: Record<string, unknown>,
): T {
  const instance = plainToInstance(cls, input);
  const errors = validateSync(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  if (errors.length > 0) {
    const messages = errors.flatMap((e) =>
      Object.values(e.constraints ?? { [e.property]: 'invalid' }),
    );
    throw new ToolInputError(messages.join('; '));
  }
  return instance;
}

function str(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ToolInputError(`${field} is required`);
  }
  return value;
}

function without(
  input: Record<string, unknown>,
  ...fields: string[]
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([k]) => !fields.includes(k)),
  );
}

export function serialize(value: unknown): string {
  const text = JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v === 'bigint') return v.toString();
    // Prisma.Decimal and similar carry their exact value in toString().
    if (v !== null && typeof v === 'object' && 'toFixed' in v && 'd' in v)
      return String(v);
    return v;
  });
  if (text === undefined) return 'null';
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}… [truncated: narrow the filters or the period]`
    : text;
}

/**
 * The assistant's tools. Every one calls an existing service with the
 * caller's own AuthenticatedUser, so project access, role rules and audit
 * behave exactly as they do for the same request made through the UI.
 */
@Injectable()
export class AssistantTools {
  constructor(
    private readonly projects: ProjectsService,
    private readonly projectAccess: ProjectAccessService,
    private readonly analytics: AnalyticsService,
    private readonly finances: FinancialPostingService,
    private readonly categories: TransactionCategoriesService,
    private readonly suppliers: SuppliersService,
    private readonly supplierLedger: SupplierLedgerService,
    private readonly purchases: PurchasesService,
    private readonly inventory: InventoryBalancesService,
  ) {}

  definitions(user: AuthenticatedUser): Anthropic.Tool[] {
    return WRITER_ROLES.includes(user.role)
      ? [...READ_TOOLS, ...WRITE_TOOLS]
      : READ_TOOLS;
  }

  async run(
    user: AuthenticatedUser,
    name: string,
    rawInput: unknown,
  ): Promise<ToolOutcome> {
    const input =
      rawInput !== null && typeof rawInput === 'object'
        ? (rawInput as Record<string, unknown>)
        : {};
    try {
      if (name === 'propose_financial_transaction') {
        return await this.proposeTransaction(user, input);
      }
      return {
        content: serialize(await this.read(user, name, input)),
        isError: false,
      };
    } catch (error) {
      return { content: describeError(error), isError: true };
    }
  }

  private async read(
    user: AuthenticatedUser,
    name: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    if (name === 'list_projects') return this.projects.listForUser(user);

    const pid = str(input, 'projectId');
    const rest = without(input, 'projectId');
    switch (name) {
      case 'get_project_summary':
        return this.analytics.getSummary(
          user,
          pid,
          parse(AnalyticsPeriodQueryDto, rest),
        );
      case 'get_cash_balance':
        return this.finances.getBalance(user, pid);
      case 'list_transactions':
        return this.finances.list(
          user,
          pid,
          parse(ListFinancialTransactionsQueryDto, rest),
        );
      case 'list_transaction_categories':
        return this.categories.list(user, pid);
      case 'list_suppliers':
        return this.suppliers.list(
          user,
          pid,
          parse(ListSuppliersQueryDto, rest),
        );
      case 'get_supplier_ledger':
        return this.supplierLedger.get(user, pid, str(input, 'supplierId'));
      case 'list_purchases':
        return this.purchases.list(
          user,
          pid,
          parse(ListPurchasesQueryDto, rest),
        );
      case 'get_inventory':
        return this.inventory.list(
          user,
          pid,
          parse(ListInventoryQueryDto, rest),
        );
      case 'get_materials_analytics':
        return this.analytics.getMaterials(
          user,
          pid,
          parse(MaterialsAnalyticsQueryDto, rest),
        );
      case 'get_construction_analytics':
        return this.analytics.getConstruction(
          user,
          pid,
          parse(ConstructionAnalyticsQueryDto, rest),
        );
      default:
        throw new ToolInputError(`Unknown tool ${name}`);
    }
  }

  private async proposeTransaction(
    user: AuthenticatedUser,
    input: Record<string, unknown>,
  ): Promise<ToolOutcome> {
    if (!WRITER_ROLES.includes(user.role)) {
      throw new ToolInputError('This user may not record transactions');
    }
    const pid = str(input, 'projectId');
    const payload = without(input, 'projectId');
    if (payload.type !== 'INCOME' && payload.type !== 'EXPENSE') {
      throw new ToolInputError('type must be INCOME or EXPENSE');
    }
    // Fail now, not at confirm time: the payload must already be a valid
    // request and the user must be allowed to write this project's cash.
    parse(CreateFinancialTransactionDto, payload);
    await this.projectAccess.assertAccess(
      user,
      pid,
      ProjectAccessAction.WRITE,
      ProjectAccessArea.CASH,
    );

    const project = await this.projects.getForUser(user, pid);
    const verb = payload.type === 'INCOME' ? 'Приход' : 'Расход';
    const party = (
      payload.type === 'INCOME' ? payload.source : payload.recipient
    ) as string | undefined;
    const summary = `${verb} ${String(payload.amount)} ${String(payload.currency)} — ${project.name}, ${String(payload.occurredAt)}${party ? `, ${party}` : ''}`;

    return {
      content: `Proposal prepared, NOT recorded yet: "${summary}". Tell the owner to confirm it on the card below.`,
      isError: false,
      proposal: {
        kind: 'CREATE_FINANCIAL_TRANSACTION',
        projectId: pid,
        payload,
        summary,
      },
    };
  }
}

function describeError(error: unknown): string {
  if (error instanceof ToolInputError) return `Invalid input: ${error.message}`;
  if (error instanceof HttpException) {
    const response = error.getResponse();
    return `Error ${error.getStatus()}: ${typeof response === 'string' ? response : JSON.stringify(response)}`;
  }
  return 'Internal error while reading the data';
}
