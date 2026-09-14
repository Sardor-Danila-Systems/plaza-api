import { ApiProperty } from '@nestjs/swagger';

export class CashFlowDto {
  @ApiProperty({
    description:
      'Balance of all ledger rows before `from` (0 if dateFrom omitted).',
  })
  opening!: string;

  @ApiProperty({
    description: 'Sum of IN-direction rows with occurredAt in [from, to).',
  })
  periodInflow!: string;

  @ApiProperty({
    description: 'Sum of OUT-direction rows with occurredAt in [from, to).',
  })
  periodOutflow!: string;

  @ApiProperty({
    description:
      'opening + periodInflow - periodOutflow — includes every ledger row before `to`, not only period rows.',
  })
  closing!: string;

  @ApiProperty({
    description:
      'The real balance right now, regardless of `to` — always returned so a historical `to` is never mistaken for the current balance.',
  })
  current!: string;
}

export class CategoryAmountDto {
  @ApiProperty({ format: 'uuid' })
  categoryId!: string;

  @ApiProperty()
  categoryName!: string;

  @ApiProperty()
  amountUzs!: string;
}

export class CurrencyAmountDto {
  @ApiProperty({ enum: ['UZS', 'USD'] })
  currency!: string;

  @ApiProperty()
  amount!: string;
}

export class AnalyticsSummaryResponseDto {
  @ApiProperty({ format: 'uuid' })
  projectId!: string;

  @ApiProperty({ nullable: true })
  dateFrom!: string | null;

  @ApiProperty({ nullable: true })
  dateTo!: string | null;

  @ApiProperty({ description: 'Wall-clock time this report was generated.' })
  generatedAt!: string;

  @ApiProperty({
    description:
      "The project's posting-sequence counter at generation time — a backdated entry posted after this moment could later restate this same [from,to) window (docs/backend-architecture.md §11).",
  })
  postingSequenceCutoff!: string;

  @ApiProperty({ type: CashFlowDto })
  cashUzs!: CashFlowDto;

  @ApiProperty({ type: CashFlowDto })
  cashUsd!: CashFlowDto;

  @ApiProperty({
    type: [CategoryAmountDto],
    description: 'EXPENSE-type rows in [from, to), by category.',
  })
  expensesByCategory!: CategoryAmountDto[];

  @ApiProperty({ description: 'SALARY-type rows in [from, to).' })
  salariesUzs!: string;

  @ApiProperty({
    description:
      'Purchase volume (occurredAt in [from, to), regardless of later cancellation).',
  })
  purchasesTotalUzs!: string;

  @ApiProperty()
  purchasesCount!: number;

  @ApiProperty({
    type: [CurrencyAmountDto],
    description:
      "Outstanding supplier debt as of `to`, per currency — reconstructed from each purchase's own currency total less effective settlements dated before `to` (never a stale denormalized field).",
  })
  supplierDebtAsOf!: CurrencyAmountDto[];

  @ApiProperty({
    type: [CurrencyAmountDto],
    description:
      'Available (unconsumed) supplier advances as of `to`, per currency.',
  })
  supplierAdvancesAvailableAsOf!: CurrencyAmountDto[];

  @ApiProperty({
    description:
      'Sum of current InventoryBalance.valueUzs across all warehouses, right now.',
  })
  currentInventoryValueUzs!: string;

  @ApiProperty({
    description:
      'Historical inventory value as of `to` — the sum of signed StockMovement value deltas before `to`, never derived from the current (mutable) InventoryBalance projection.',
  })
  inventoryValueAsOfUzs!: string;
}
