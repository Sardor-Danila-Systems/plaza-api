import { Prisma } from '../../generated/prisma/client.js';
import { distributeLargestRemainder } from './largest-remainder.util.js';

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

describe('distributeLargestRemainder', () => {
  it('sums exactly to the target total even with fractional remainders', () => {
    // Three equal-weight lines splitting 100 three ways: 33.33 + 33.33 + 33.34
    const weights = [d('1'), d('1'), d('1')];
    const result = distributeLargestRemainder(weights, d('100'));
    const sum = result.reduce((acc, r) => acc.plus(r), new Prisma.Decimal(0));
    expect(sum.toFixed(2)).toBe('100.00');
    expect(result.map((r) => r.toFixed(2)).sort()).toEqual([
      '33.33',
      '33.33',
      '33.34',
    ]);
  });

  it('distributes proportionally to weights, not equally', () => {
    const weights = [d('100'), d('300')]; // 1:3 ratio
    const result = distributeLargestRemainder(weights, d('1000'));
    expect(result[0].toFixed(2)).toBe('250.00');
    expect(result[1].toFixed(2)).toBe('750.00');
  });

  it('handles a single line (gets the full total)', () => {
    const result = distributeLargestRemainder([d('123.45')], d('999.99'));
    expect(result[0].toFixed(2)).toBe('999.99');
  });

  it('sums exactly for many lines with awkward fractions', () => {
    const weights = [d('7'), d('11'), d('13'), d('17'), d('19')];
    const total = d('1000000.01');
    const result = distributeLargestRemainder(weights, total);
    const sum = result.reduce((acc, r) => acc.plus(r), new Prisma.Decimal(0));
    expect(sum.toFixed(2)).toBe(total.toFixed(2));
  });

  it('breaks ties by stable line index', () => {
    // Two identical weights splitting an odd cent count -> the earlier
    // index gets the extra cent deterministically, every time.
    const weights = [d('1'), d('1')];
    const result = distributeLargestRemainder(weights, d('0.01'));
    expect(result[0].toFixed(2)).toBe('0.01');
    expect(result[1].toFixed(2)).toBe('0.00');
  });

  it('returns an empty array for no weights', () => {
    expect(distributeLargestRemainder([], d('100'))).toEqual([]);
  });

  it('matches the worked example from backend-architecture.md-style invoices', () => {
    // Three lines of 70000, 80000, 100000 (UZS-equivalent), converting to a
    // total that does not divide evenly.
    const weights = [d('70000'), d('80000'), d('100000')];
    const total = d('3123456.78');
    const result = distributeLargestRemainder(weights, total);
    const sum = result.reduce((acc, r) => acc.plus(r), new Prisma.Decimal(0));
    expect(sum.toFixed(2)).toBe('3123456.78');
  });
});
