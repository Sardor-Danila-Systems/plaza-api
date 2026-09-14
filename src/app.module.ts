import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { PrismaModule } from './database/prisma.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { ConstructionModule } from './modules/construction/construction.module.js';
import { FinancesModule } from './modules/finances/finances.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { ProjectsModule } from './modules/projects/projects.module.js';
import { PurchasesModule } from './modules/purchases/purchases.module.js';
import { SuppliersModule } from './modules/suppliers/suppliers.module.js';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    HealthModule,
    AuthModule,
    ProjectsModule,
    ConstructionModule,
    AuditModule,
    FinancesModule,
    InventoryModule,
    SuppliersModule,
    PurchasesModule,
  ],
})
export class AppModule {}
