import { ApiProperty } from '@nestjs/swagger';

/**
 * Nominal (original-currency) balances only — docs/backend-architecture.md
 * §4: "the spending check uses nominal balances", never a UZS-equivalent
 * total treated as combined availability across currencies ("never infer
 * USD availability from a UZS reporting balance").
 */
export class BalanceResponseDto {
  @ApiProperty({
    example: '4500000.00',
    description:
      'Nominal UZS balance: sum of IN amounts minus sum of OUT amounts, UZS rows only.',
  })
  uzs!: string;

  @ApiProperty({
    example: '1200.00',
    description:
      'Nominal USD balance: sum of IN amounts minus sum of OUT amounts, USD rows only.',
  })
  usd!: string;
}
