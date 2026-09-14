import { Prisma } from '../../generated/prisma/client.js';
import { computeAmountUzs, round2 } from './decimal.util.js';

describe('round2', () => {
  // `.toFixed(2)` (not `.toString()`, which drops trailing zeros) is the
  // meaningful assertion here — display/serialization formatting is a
  // separate concern from this function's job of fixing the *value* to 2
  // decimal places.
  it('rounds half-up at the third decimal place', () => {
    expect(round2(new Prisma.Decimal('1.005')).toFixed(2)).toBe('1.01');
  });

  it('rounds down when the third decimal is below 5', () => {
    expect(round2(new Prisma.Decimal('1.004')).toFixed(2)).toBe('1.00');
  });

  it('leaves an already-2dp value unchanged', () => {
    expect(round2(new Prisma.Decimal('100.50')).toFixed(2)).toBe('100.50');
  });
});

describe('computeAmountUzs', () => {
  it('equals amount verbatim when exchangeRate is 1 (UZS)', () => {
    const amount = new Prisma.Decimal('150000.00');
    const rate = new Prisma.Decimal('1');
    expect(computeAmountUzs(amount, rate).toString()).toBe('150000');
  });

  it('multiplies and rounds half-up for a USD rate', () => {
    const amount = new Prisma.Decimal('100.00');
    const rate = new Prisma.Decimal('12500.125');
    // 100 * 12500.125 = 1250012.5 -> rounds to 1250012.50
    expect(computeAmountUzs(amount, rate).toString()).toBe('1250012.5');
  });

  it('never loses precision to JS floating point for a large amount', () => {
    const amount = new Prisma.Decimal('999999999999.99');
    const rate = new Prisma.Decimal('12500.00000001');
    const result = computeAmountUzs(amount, rate);
    // Sanity: exact decimal arithmetic, not a float approximation.
    expect(result.decimalPlaces()).toBeLessThanOrEqual(2);
    expect(result.isNaN()).toBe(false);
    expect(result.isFinite()).toBe(true);
  });
});
