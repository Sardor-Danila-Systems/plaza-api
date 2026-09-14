import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { RateSource } from '../../../generated/prisma/client.js';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { ProjectAccessAction } from '../../projects/project-access-action.enum.js';
import { ProjectAccessService } from '../../projects/project-access.service.js';
import { CreateCurrencyRateDto } from './dto/create-currency-rate.dto.js';
import { CurrencyRateResponseDto } from './dto/currency-rate-response.dto.js';

@Injectable()
export class CurrencyRatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  async list(
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<CurrencyRateResponseDto[]> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    const rates = await this.prisma.client.currencyRate.findMany({
      where: { projectId },
      orderBy: [{ effectiveOn: 'desc' }, { createdAt: 'desc' }],
    });
    return rates.map((rate) => ({
      id: rate.id,
      projectId: rate.projectId,
      currency: rate.currency,
      rateUzs: rate.rateUzs.toFixed(8),
      effectiveOn: rate.effectiveOn.toISOString().slice(0, 10),
      source: rate.source,
      createdById: rate.createdById,
      createdAt: rate.createdAt,
    }));
  }

  /**
   * Append-only manual quote entry (docs/backend-architecture.md's route
   * table: "Historical project quotes and append-only manual quote
   * creation") — no project lock: this never touches a project's cash
   * balance or any row a concurrent finance posting reads for its own
   * correctness (a FinancialTransaction snapshots the rate it used at
   * posting time and never re-reads a CurrencyRate afterward), so there is
   * no cross-row invariant here that the project-lock protocol exists to
   * protect (transaction-design.md §1 lists exactly which workflows need
   * it; this master-data-like append is not one of them, the same as
   * Phase 3's BuildingBlock/Floor creation).
   */
  async create(
    user: AuthenticatedUser,
    projectId: string,
    dto: CreateCurrencyRateDto,
  ): Promise<CurrencyRateResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.WRITE,
    );
    const rate = await this.prisma.client.currencyRate.create({
      data: {
        projectId,
        currency: dto.currency,
        rateUzs: new Prisma.Decimal(dto.rateUzs),
        effectiveOn: new Date(`${dto.effectiveOn}T00:00:00.000Z`),
        source: RateSource.MANUAL,
        createdById: user.id,
      },
    });
    return {
      id: rate.id,
      projectId: rate.projectId,
      currency: rate.currency,
      rateUzs: rate.rateUzs.toFixed(8),
      effectiveOn: rate.effectiveOn.toISOString().slice(0, 10),
      source: rate.source,
      createdById: rate.createdById,
      createdAt: rate.createdAt,
    };
  }
}
