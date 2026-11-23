import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';
import { Currency } from '../../../../generated/prisma/client.js';

export class CreateEmployeeDto {
  @ApiProperty({ example: 'Иванов Иван' })
  @IsString()
  @Length(1, 200)
  name!: string;
}

export class UpdateEmployeeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class AdvanceBalanceDto {
  @ApiProperty({ enum: Currency })
  currency!: Currency;
  @ApiProperty({ description: 'Всего выдано авансов (без отменённых)' })
  advanced!: string;
  @ApiProperty({ description: 'Удержано из зарплат (без отменённых выплат)' })
  deducted!: string;
  @ApiProperty({ description: 'Остаток неудержанных авансов' })
  outstanding!: string;
}

export class EmployeeResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ type: [AdvanceBalanceDto] }) balances!: AdvanceBalanceDto[];
}

export class OpenAdvanceDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() occurredAt!: string;
  @ApiProperty({ enum: Currency }) currency!: Currency;
  @ApiProperty() amount!: string;
  @ApiProperty() deducted!: string;
  @ApiProperty() remaining!: string;
}

export class LedgerDeductionDto {
  @ApiProperty({ format: 'uuid' }) advanceId!: string;
  @ApiProperty() amount!: string;
}

export class LedgerEntryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['ADVANCE', 'PAYOUT'] }) kind!: 'ADVANCE' | 'PAYOUT';
  @ApiProperty() occurredAt!: string;
  @ApiProperty({ enum: Currency }) currency!: Currency;
  @ApiProperty({
    description: 'Для аванса — сумма аванса, для выплаты — «к выдаче»',
  })
  amount!: string;
  @ApiProperty({ nullable: true, description: 'Начислено (только выплата)' })
  accruedAmount!: string | null;
  @ApiProperty({
    type: [LedgerDeductionDto],
    description: 'Удержания (только выплата)',
  })
  deductions!: LedgerDeductionDto[];
  @ApiProperty() account!: string;
  @ApiProperty({ nullable: true }) comment!: string | null;
  @ApiProperty() cancelled!: boolean;
}

export class EmployeeLedgerResponseDto {
  @ApiProperty({ type: EmployeeResponseDto }) employee!: EmployeeResponseDto;
  @ApiProperty({ type: [OpenAdvanceDto] }) openAdvances!: OpenAdvanceDto[];
  @ApiProperty({ type: [LedgerEntryDto] }) entries!: LedgerEntryDto[];
}
