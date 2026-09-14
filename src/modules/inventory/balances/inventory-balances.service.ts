import { Injectable } from '@nestjs/common';
import { averageCostUzs } from '../../../common/inventory/costing.util.js';
import { isLowStock } from '../../../common/inventory/low-stock.util.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { ProjectAccessAction } from '../../projects/project-access-action.enum.js';
import { ProjectAccessService } from '../../projects/project-access.service.js';
import { InventoryBalanceResponseDto } from './dto/inventory-balance-response.dto.js';
import { ListInventoryQueryDto } from './dto/list-inventory-query.dto.js';

type BalanceWithJoins = Prisma.InventoryBalanceGetPayload<{
  include: { warehouse: true; material: { include: { unit: true } } };
}>;

/**
 * Read-only current-inventory projection (this phase's §23). Returns
 * existing `InventoryBalance` rows only — a material with no warehouse
 * presence yet has no row to return, matching Phase 5's status as
 * foundation-only (no workflow creates `InventoryBalance` rows until
 * Phase 7/8's purchase-receipt/write-off/transfer land).
 */
@Injectable()
export class InventoryBalancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  async list(
    user: AuthenticatedUser,
    projectId: string,
    query: ListInventoryQueryDto,
  ): Promise<InventoryBalanceResponseDto[]> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );

    const where: Prisma.InventoryBalanceWhereInput = { projectId };
    if (query.warehouseId) {
      where.warehouseId = query.warehouseId;
    }
    if (query.materialId) {
      where.materialId = query.materialId;
    }
    if (query.categoryId) {
      where.material = { categoryId: query.categoryId };
    }
    if (query.search) {
      where.material = {
        ...(where.material as Prisma.MaterialWhereInput | undefined),
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { code: { contains: query.search, mode: 'insensitive' } },
        ],
      };
    }

    const balances = await this.prisma.client.inventoryBalance.findMany({
      where,
      include: { warehouse: true, material: { include: { unit: true } } },
      orderBy: [{ material: { name: 'asc' } }, { warehouse: { name: 'asc' } }],
    });

    // `lowStock` compares two columns across a relation
    // (InventoryBalance.quantity < Material.minimumStock), which Prisma's
    // query builder cannot express without a raw query; filtering
    // in-process here is deliberate given a project's inventory row count
    // is bounded (per-project warehouse x material combinations), not an
    // unbounded global table — every other filter above already reduces
    // this to a materialized project-scoped subset before this runs.
    const responses = balances.map(this.toResponse);
    if (query.lowStock === undefined) {
      return responses;
    }
    return responses.filter((row) => row.lowStock === query.lowStock);
  }

  private toResponse(balance: BalanceWithJoins): InventoryBalanceResponseDto {
    const avgCost = averageCostUzs({
      quantity: balance.quantity,
      valueUzs: balance.valueUzs,
    });
    return {
      id: balance.id,
      projectId: balance.projectId,
      warehouseId: balance.warehouseId,
      warehouseName: balance.warehouse.name,
      materialId: balance.materialId,
      materialName: balance.material.name,
      unitId: balance.material.unitId,
      unitSymbol: balance.material.unit.symbol,
      categoryId: balance.material.categoryId,
      quantity: balance.quantity.toFixed(6),
      averageCostUzs: avgCost.toFixed(8),
      valueUzs: balance.valueUzs.toFixed(8),
      minimumStock: balance.material.minimumStock
        ? balance.material.minimumStock.toFixed(6)
        : null,
      lowStock: isLowStock(balance.quantity, balance.material.minimumStock),
      updatedAt: balance.updatedAt,
    };
  }
}
