import { Prisma } from '../../generated/prisma/client.js';

/**
 * docs/backend-architecture.md §2: "Null threshold disables the warning;
 * equality is not low stock" — strict `<`, and `minimumStock === null`
 * always returns `false`, never treated as "always low" or "never checked
 * either way by omission".
 */
export function isLowStock(
  quantity: Prisma.Decimal,
  minimumStock: Prisma.Decimal | null,
): boolean {
  if (minimumStock === null) {
    return false;
  }
  return quantity.lessThan(minimumStock);
}
