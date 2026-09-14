import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { InventoryBalancesController } from './balances/inventory-balances.controller.js';
import { InventoryBalancesService } from './balances/inventory-balances.service.js';
import { MaterialCategoriesController } from './material-categories/material-categories.controller.js';
import { MaterialCategoriesService } from './material-categories/material-categories.service.js';
import { MaterialsController } from './materials/materials.controller.js';
import { MaterialsService } from './materials/materials.service.js';
import { TransfersController } from './transfers/transfers.controller.js';
import { TransfersService } from './transfers/transfers.service.js';
import { UnitsController } from './units/units.controller.js';
import { UnitsService } from './units/units.service.js';
import { WarehousesController } from './warehouses/warehouses.controller.js';
import { WarehousesService } from './warehouses/warehouses.service.js';
import { WriteOffsController } from './write-offs/write-offs.controller.js';
import { WriteOffsService } from './write-offs/write-offs.service.js';

@Module({
  imports: [ProjectsModule, AuditModule],
  controllers: [
    WarehousesController,
    UnitsController,
    MaterialCategoriesController,
    MaterialsController,
    InventoryBalancesController,
    WriteOffsController,
    TransfersController,
  ],
  providers: [
    WarehousesService,
    UnitsService,
    MaterialCategoriesService,
    MaterialsService,
    InventoryBalancesService,
    WriteOffsService,
    TransfersService,
  ],
  exports: [
    WarehousesService,
    MaterialsService,
    MaterialCategoriesService,
    UnitsService,
  ],
})
export class InventoryModule {}
