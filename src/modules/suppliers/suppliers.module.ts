import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { FinancesModule } from '../finances/finances.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { SupplierAdvancesController } from './advances/supplier-advances.controller.js';
import { SupplierAdvancesService } from './advances/supplier-advances.service.js';
import { DebtPaymentsController } from './debt-payments/debt-payments.controller.js';
import { DebtPaymentsService } from './debt-payments/debt-payments.service.js';
import { SupplierLedgerController } from './ledger/supplier-ledger.controller.js';
import { SupplierLedgerService } from './ledger/supplier-ledger.service.js';
import { SuppliersController } from './suppliers.controller.js';
import { SuppliersService } from './suppliers.service.js';

@Module({
  imports: [ProjectsModule, AuditModule, FinancesModule],
  controllers: [
    SuppliersController,
    SupplierAdvancesController,
    DebtPaymentsController,
    SupplierLedgerController,
  ],
  providers: [
    SuppliersService,
    SupplierAdvancesService,
    DebtPaymentsService,
    SupplierLedgerService,
  ],
  exports: [SuppliersService],
})
export class SuppliersModule {}
