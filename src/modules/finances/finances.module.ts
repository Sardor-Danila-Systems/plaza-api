import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { TransactionCategoriesController } from './categories/transaction-categories.controller.js';
import { TransactionCategoriesService } from './categories/transaction-categories.service.js';
import { CurrencyRatesController } from './currency-rates/currency-rates.controller.js';
import { CurrencyRatesService } from './currency-rates/currency-rates.service.js';
import { FinancialPostingService } from './financial-posting.service.js';
import { FinancialTransactionsController } from './financial-transactions.controller.js';

@Module({
  imports: [ProjectsModule, AuditModule],
  controllers: [
    FinancialTransactionsController,
    TransactionCategoriesController,
    CurrencyRatesController,
  ],
  providers: [
    FinancialPostingService,
    TransactionCategoriesService,
    CurrencyRatesService,
  ],
  exports: [FinancialPostingService],
})
export class FinancesModule {}
