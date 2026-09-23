import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { RateSource } from '../../../generated/prisma/client.js';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { ProjectAccessAction } from '../../projects/project-access-action.enum.js';
import { ProjectAccessService } from '../../projects/project-access.service.js';
import { CreateCurrencyRateDto } from './dto/create-currency-rate.dto.js';
import { CurrencyRateResponseDto } from './dto/currency-rate-response.dto.js';
import { LiveCurrencyRateResponseDto } from './dto/live-currency-rate-response.dto.js';

const CBU_USD_RATE_URL = 'https://cbu.uz/en/arkhiv-kursov-valyut/json/USD/';
const LIVE_RATE_CACHE_TTL_MS = 45 * 60 * 1000;
const LIVE_RATE_FETCH_TIMEOUT_MS = 5000;

interface CbuRateEntry {
  Rate: string;
  Date: string;
}

interface LiveRateCacheEntry {
  rateUzs: string;
  asOf: string;
  fetchedAt: number;
}

@Injectable()
export class CurrencyRatesService {
  private liveRateCache: LiveRateCacheEntry | null = null;

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
        source: dto.source ?? RateSource.MANUAL,
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

  /**
   * Read-only live USD/UZS quote from the Central Bank of Uzbekistan
   * (cbu.uz) — does NOT write a CurrencyRate row itself; the frontend saves
   * one explicitly (via `create`, `source: PROVIDER`) only when a user acts
   * on it. Cached in-memory per process for `LIVE_RATE_CACHE_TTL_MS` to
   * avoid hammering cbu.uz on every Kassa page load; falls back to the last
   * good cached value (marked `stale`) if a refetch fails.
   */
  async getLiveRate(
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<LiveCurrencyRateResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );

    const now = Date.now();
    if (this.liveRateCache && now - this.liveRateCache.fetchedAt < LIVE_RATE_CACHE_TTL_MS) {
      return {
        rateUzs: this.liveRateCache.rateUzs,
        asOf: this.liveRateCache.asOf,
        source: RateSource.PROVIDER,
        stale: false,
      };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        LIVE_RATE_FETCH_TIMEOUT_MS,
      );
      let entries: CbuRateEntry[];
      try {
        const response = await fetch(CBU_USD_RATE_URL, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`cbu.uz responded with ${response.status}`);
        }
        entries = (await response.json()) as CbuRateEntry[];
      } finally {
        clearTimeout(timeout);
      }

      const entry = entries[0];
      if (!entry?.Rate || !entry.Date) {
        throw new Error('cbu.uz response missing Rate/Date');
      }

      const [day, month, year] = entry.Date.split('.');
      const asOf = `${year}-${month}-${day}`;

      this.liveRateCache = { rateUzs: entry.Rate, asOf, fetchedAt: now };
      return { rateUzs: entry.Rate, asOf, source: RateSource.PROVIDER, stale: false };
    } catch {
      if (this.liveRateCache) {
        return {
          rateUzs: this.liveRateCache.rateUzs,
          asOf: this.liveRateCache.asOf,
          source: RateSource.PROVIDER,
          stale: true,
        };
      }
      throw new ServiceUnavailableException(
        'Не удалось получить актуальный курс USD/UZS',
      );
    }
  }
}
