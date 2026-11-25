import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service.js';
import { Currency, Prisma } from '../../../generated/prisma/client.js';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { ProjectAccessAction } from '../../projects/project-access-action.enum.js';
import { ProjectAccessArea } from '../../projects/project-access-area.enum.js';
import { ProjectAccessService } from '../../projects/project-access.service.js';
import {
  AdvanceBalanceDto,
  CreateEmployeeDto,
  EmployeeLedgerResponseDto,
  EmployeeResponseDto,
  LedgerEntryDto,
  OpenAdvanceDto,
  UpdateEmployeeDto,
} from './dto/employee.dto.js';
import { deductedByAdvance, listAdvances } from './salary-advance.util.js';

const ZERO = new Prisma.Decimal(0);

function balancesOf(
  advances: {
    currency: Currency;
    amount: Prisma.Decimal;
    deducted: Prisma.Decimal;
  }[],
): AdvanceBalanceDto[] {
  const byCurrency = new Map<
    Currency,
    { a: Prisma.Decimal; d: Prisma.Decimal }
  >();
  for (const x of advances) {
    const cur = byCurrency.get(x.currency) ?? { a: ZERO, d: ZERO };
    byCurrency.set(x.currency, {
      a: cur.a.add(x.amount),
      d: cur.d.add(x.deducted),
    });
  }
  return [...byCurrency.entries()].map(([currency, v]) => ({
    currency,
    advanced: v.a.toFixed(2),
    deducted: v.d.toFixed(2),
    outstanding: v.a.sub(v.d).toFixed(2),
  }));
}

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  private async assertRead(user: AuthenticatedUser, projectId: string) {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
      ProjectAccessArea.CASH,
    );
  }

  async list(
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<EmployeeResponseDto[]> {
    await this.assertRead(user, projectId);
    const db = this.prisma.client;
    const employees = await db.employee.findMany({
      where: { projectId },
      orderBy: { name: 'asc' },
    });
    const advances = await db.financialTransaction.findMany({
      where: {
        projectId,
        employeeId: { not: null },
        isAdvance: true,
        reversalOfId: null,
        cancelledAt: null,
      },
      select: { id: true, employeeId: true, currency: true, amount: true },
    });
    const deducted = await deductedByAdvance(
      db,
      projectId,
      advances.map((a) => a.id),
    );
    return employees.map((e) => ({
      id: e.id,
      name: e.name,
      isActive: e.isActive,
      balances: balancesOf(
        advances
          .filter((a) => a.employeeId === e.id)
          .map((a) => ({
            currency: a.currency,
            amount: a.amount,
            deducted: deducted.get(a.id) ?? ZERO,
          })),
      ),
    }));
  }

  async create(
    user: AuthenticatedUser,
    projectId: string,
    dto: CreateEmployeeDto,
  ): Promise<EmployeeResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.WRITE,
      ProjectAccessArea.CASH,
    );
    const e = await this.prisma.client.employee.create({
      data: { projectId, name: dto.name.trim() },
    });
    return { id: e.id, name: e.name, isActive: e.isActive, balances: [] };
  }

  async update(
    user: AuthenticatedUser,
    projectId: string,
    employeeId: string,
    dto: UpdateEmployeeDto,
  ): Promise<EmployeeResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.WRITE,
      ProjectAccessArea.CASH,
    );
    const existing = await this.prisma.client.employee.findFirst({
      where: { id: employeeId, projectId },
    });
    if (!existing) this.notFound();
    await this.prisma.client.employee.update({
      where: { id: employeeId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
    return this.one(projectId, employeeId);
  }

  async openAdvances(
    user: AuthenticatedUser,
    projectId: string,
    employeeId: string,
  ): Promise<OpenAdvanceDto[]> {
    await this.assertRead(user, projectId);
    await this.one(projectId, employeeId);
    const advances = await listAdvances(
      this.prisma.client,
      projectId,
      employeeId,
    );
    return advances.filter((a) => a.remaining.gt(0)).map((a) => this.toOpen(a));
  }

  async ledger(
    user: AuthenticatedUser,
    projectId: string,
    employeeId: string,
  ): Promise<EmployeeLedgerResponseDto> {
    await this.assertRead(user, projectId);
    const employee = await this.one(projectId, employeeId);
    const db = this.prisma.client;
    const rows = await db.financialTransaction.findMany({
      where: { projectId, employeeId, reversalOfId: null },
      include: { deductionsAsPayout: true },
      orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
    });
    const entries: LedgerEntryDto[] = rows.map((r) => ({
      id: r.id,
      kind: r.isAdvance ? 'ADVANCE' : 'PAYOUT',
      occurredAt: r.occurredAt.toISOString().slice(0, 10),
      currency: r.currency,
      amount: r.amount.toFixed(2),
      accruedAmount: r.accruedAmount ? r.accruedAmount.toFixed(2) : null,
      deductions: r.deductionsAsPayout.map((d) => ({
        advanceId: d.advanceId,
        amount: d.amount.toFixed(2),
      })),
      account: r.account,
      comment: r.comment,
      cancelled: r.cancelledAt !== null,
    }));
    const open = (await listAdvances(db, projectId, employeeId)).filter((a) =>
      a.remaining.gt(0),
    );
    return {
      employee,
      openAdvances: open.map((a) => this.toOpen(a)),
      entries,
    };
  }

  private toOpen(a: {
    id: string;
    occurredAt: Date;
    currency: Currency;
    amount: Prisma.Decimal;
    deducted: Prisma.Decimal;
    remaining: Prisma.Decimal;
  }): OpenAdvanceDto {
    return {
      id: a.id,
      occurredAt: a.occurredAt.toISOString().slice(0, 10),
      currency: a.currency,
      amount: a.amount.toFixed(2),
      deducted: a.deducted.toFixed(2),
      remaining: a.remaining.toFixed(2),
    };
  }

  private async one(
    projectId: string,
    employeeId: string,
  ): Promise<EmployeeResponseDto> {
    const e = await this.prisma.client.employee.findFirst({
      where: { id: employeeId, projectId },
    });
    if (!e) this.notFound();
    const advances = await listAdvances(
      this.prisma.client,
      projectId,
      employeeId,
    );
    return {
      id: e.id,
      name: e.name,
      isActive: e.isActive,
      balances: balancesOf(advances),
    };
  }

  private notFound(): never {
    throw new NotFoundException({
      code: 'NOT_FOUND',
      message: 'Employee not found in this project',
    });
  }
}
