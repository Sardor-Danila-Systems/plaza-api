import { Prisma } from '../../generated/prisma/client.js';
import { isLowStock } from './low-stock.util.js';

describe('isLowStock', () => {
  it('is false when minimumStock is null', () => {
    expect(isLowStock(new Prisma.Decimal(0), null)).toBe(false);
  });

  it('is true when quantity is strictly less than minimumStock', () => {
    expect(isLowStock(new Prisma.Decimal('5'), new Prisma.Decimal('10'))).toBe(
      true,
    );
  });

  it('is false when quantity equals minimumStock (equality is not low stock)', () => {
    expect(isLowStock(new Prisma.Decimal('10'), new Prisma.Decimal('10'))).toBe(
      false,
    );
  });

  it('is false when quantity exceeds minimumStock', () => {
    expect(isLowStock(new Prisma.Decimal('15'), new Prisma.Decimal('10'))).toBe(
      false,
    );
  });
});
