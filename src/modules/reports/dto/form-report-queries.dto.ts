import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { CashAccount } from '../../../generated/prisma/client.js';
import { ReportPeriodQueryDto } from './report-period-query.dto.js';

export class SupplierReconciliationQueryDto extends ReportPeriodQueryDto {
  @ApiProperty({ description: 'Supplier to reconcile with' })
  @IsUUID()
  supplierId!: string;
}

export class MaterialReportQueryDto extends ReportPeriodQueryDto {
  @ApiPropertyOptional({ description: 'Limit the report to one warehouse' })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;
}

export class CashJournalQueryDto extends ReportPeriodQueryDto {
  @ApiPropertyOptional({ enum: CashAccount, description: 'Default: both' })
  @IsOptional()
  @IsEnum(CashAccount)
  account?: CashAccount;
}
