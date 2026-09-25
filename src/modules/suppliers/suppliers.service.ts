import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma, Supplier } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { ProjectAccessAction } from '../projects/project-access-action.enum.js';
import { ProjectAccessService } from '../projects/project-access.service.js';
import { CreateSupplierDto } from './dto/create-supplier.dto.js';
import { ListSuppliersQueryDto } from './dto/list-suppliers-query.dto.js';
import { SupplierResponseDto } from './dto/supplier-response.dto.js';
import { UpdateSupplierDto } from './dto/update-supplier.dto.js';

/** Master-data CRUD, the same shape as Phase 5's `WarehousesService` — no
 * project lock (creating/renaming/archiving a supplier never touches cash,
 * debt, or advance state). */
@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly audit: AuditService,
  ) {}

  async list(
    user: AuthenticatedUser,
    projectId: string,
    query: ListSuppliersQueryDto = {},
  ): Promise<SupplierResponseDto[]> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );

    const where: Prisma.SupplierWhereInput = { projectId };
    if (query.isActive !== undefined) {
      where.isActive = query.isActive;
    }
    if (query.search) {
      // Phone and taxpayer id are searched as plain substrings: whoever is
      // holding the invoice reads the digits off it, and asking them to
      // match the punctuation a phone number happens to be stored with
      // would make the field useless.
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { contactPerson: { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search } },
        { taxId: { contains: query.search } },
      ];
    }

    const suppliers = await this.prisma.client.supplier.findMany({
      where,
      orderBy: { name: 'asc' },
    });
    return suppliers.map(this.toResponse);
  }

  async get(
    user: AuthenticatedUser,
    projectId: string,
    supplierId: string,
  ): Promise<SupplierResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    const supplier = await this.getSupplierOrThrow(projectId, supplierId);
    return this.toResponse(supplier);
  }

  async create(
    user: AuthenticatedUser,
    projectId: string,
    dto: CreateSupplierDto,
    requestId?: string,
  ): Promise<SupplierResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.WRITE,
    );

    const supplier = await this.prisma.client.supplier.create({
      data: {
        projectId,
        name: dto.name,
        contactPerson: dto.contactPerson,
        phone: dto.phone,
        taxId: dto.taxId,
        comment: dto.comment,
      },
    });

    await this.prisma.client.$transaction(async (tx) => {
      await this.audit.record(tx, {
        projectId,
        actorId: user.id,
        action: 'supplier.create',
        entityType: 'Supplier',
        entityId: supplier.id,
        requestId,
        newData: { ...this.toResponse(supplier) },
      });
    });

    return this.toResponse(supplier);
  }

  async update(
    user: AuthenticatedUser,
    projectId: string,
    supplierId: string,
    dto: UpdateSupplierDto,
    requestId?: string,
  ): Promise<SupplierResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.WRITE,
    );
    const existing = await this.getSupplierOrThrow(projectId, supplierId);

    const updated = await this.prisma.client.$transaction(async (tx) => {
      const supplier = await tx.supplier.update({
        where: { id: supplierId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.contactPerson !== undefined
            ? { contactPerson: dto.contactPerson }
            : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          ...(dto.taxId !== undefined ? { taxId: dto.taxId } : {}),
          ...(dto.comment !== undefined ? { comment: dto.comment } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
      await this.audit.record(tx, {
        projectId,
        actorId: user.id,
        action: 'supplier.update',
        entityType: 'Supplier',
        entityId: supplier.id,
        requestId,
        previousData: { ...this.toResponse(existing) },
        newData: { ...this.toResponse(supplier) },
      });
      return supplier;
    });

    return this.toResponse(updated);
  }

  async getSupplierOrThrow(
    projectId: string,
    supplierId: string,
  ): Promise<Supplier> {
    const supplier = await this.prisma.client.supplier.findFirst({
      where: { id: supplierId, projectId },
    });
    if (!supplier) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Supplier not found in this project',
      });
    }
    return supplier;
  }

  private toResponse(supplier: Supplier): SupplierResponseDto {
    return {
      id: supplier.id,
      projectId: supplier.projectId,
      name: supplier.name,
      contactPerson: supplier.contactPerson,
      phone: supplier.phone,
      taxId: supplier.taxId,
      comment: supplier.comment,
      isActive: supplier.isActive,
      createdAt: supplier.createdAt,
    };
  }
}
