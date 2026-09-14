import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { FinancesModule } from '../finances/finances.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { PurchasesController } from './purchases.controller.js';
import { PurchasesService } from './purchases.service.js';

@Module({
  imports: [ProjectsModule, AuditModule, FinancesModule],
  controllers: [PurchasesController],
  providers: [PurchasesService],
  exports: [PurchasesService],
})
export class PurchasesModule {}
