import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module.js';
import { FinancesModule } from '../finances/finances.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { PurchasesModule } from '../purchases/purchases.module.js';
import { SuppliersModule } from '../suppliers/suppliers.module.js';
import { AssistantController } from './assistant.controller.js';
import { AssistantTools } from './assistant-tools.js';
import { AssistantService } from './assistant.service.js';

@Module({
  imports: [
    ProjectsModule,
    AnalyticsModule,
    FinancesModule,
    SuppliersModule,
    PurchasesModule,
    InventoryModule,
  ],
  controllers: [AssistantController],
  providers: [AssistantService, AssistantTools],
})
export class AssistantModule {}
