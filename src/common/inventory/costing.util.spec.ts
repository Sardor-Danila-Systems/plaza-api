import { Prisma } from '../../generated/prisma/client.js';
import {
  InsufficientStockError,
  averageCostUzs,
  depleteStock,
  receiveStock,
} from './costing.util.js';

function pos(quantity: string, valueUzs: string) {
  return {
    quantity: new Prisma.Decimal(quantity),
    valueUzs: new Prisma.Decimal(valueUzs),
  };
}

describe('averageCostUzs', () => {
  it('is valueUzs / quantity', () => {
    expect(averageCostUzs(pos('10', '1000')).toString()).toBe('100');
  });

  it('is exactly 0 when quantity is 0, never a division-by-zero error', () => {
    expect(averageCostUzs(pos('0', '0')).toString()).toBe('0');
  });
});

describe('receiveStock', () => {
  it('matches the worked example: qty 10 @ avg 100 + qty 10 @ cost 200 => qty 20 @ avg 150', () => {
    const current = pos('10', '1000'); // 10 * 100 average
    const { result, totalCostUzs } = receiveStock(
      current,
      new Prisma.Decimal('10'),
      new Prisma.Decimal('200'),
    );
    expect(totalCostUzs.toString()).toBe('2000');
    expect(result.quantity.toString()).toBe('20');
    expect(result.valueUzs.toString()).toBe('3000');
    expect(averageCostUzs(result).toString()).toBe('150');
  });

  it('handles fractional quantities exactly (0.1 @ 100 then 0.2 @ 200)', () => {
    const first = receiveStock(
      pos('0', '0'),
      new Prisma.Decimal('0.1'),
      new Prisma.Decimal('100'),
    );
    expect(first.result.quantity.toString()).toBe('0.1');
    expect(first.result.valueUzs.toString()).toBe('10');

    const second = receiveStock(
      first.result,
      new Prisma.Decimal('0.2'),
      new Prisma.Decimal('200'),
    );
    expect(second.result.quantity.toString()).toBe('0.3');
    expect(second.result.valueUzs.toString()).toBe('50');
    // (10 + 40) / 0.3 = 166.66666...7 average, but VALUE stays exact —
    // only the derived average ratio is a repeating decimal, confirming
    // why value (not average) is the persisted column.
    expect(averageCostUzs(second.result).toFixed(2)).toBe('166.67');
  });

  it('handles a large-magnitude receipt without precision loss', () => {
    const current = pos('1000000.000000', '50000000000.00000000');
    const { result } = receiveStock(
      current,
      new Prisma.Decimal('999999.999999'),
      new Prisma.Decimal('12345.6789'),
    );
    // Sanity: exact decimal arithmetic, not a float approximation losing
    // low-order digits at this magnitude.
    expect(result.quantity.toString()).toBe('1999999.999999');
    expect(result.valueUzs.isFinite()).toBe(true);
    expect(result.valueUzs.isNaN()).toBe(false);
  });

  it('rounds the receipt value to 8 decimal places', () => {
    const { totalCostUzs } = receiveStock(
      pos('0', '0'),
      new Prisma.Decimal('3'),
      new Prisma.Decimal('0.123456785'),
    );
    // 3 * 0.123456785 = 0.370370355 -> rounds to 8dp half-up
    expect(totalCostUzs.toFixed(8)).toBe('0.37037036');
  });
});

describe('depleteStock', () => {
  it('matches the worked example: current 10, out 3 => 7 remaining, average unchanged', () => {
    const current = pos('10', '1000'); // average 100
    const { result, unitCostUzs, totalCostUzs } = depleteStock(
      current,
      new Prisma.Decimal('3'),
    );
    expect(unitCostUzs.toString()).toBe('100');
    expect(totalCostUzs.toString()).toBe('300');
    expect(result.quantity.toString()).toBe('7');
    expect(result.valueUzs.toString()).toBe('700');
    expect(averageCostUzs(result).toString()).toBe('100');
  });

  it('matches the worked example: current 10, out 10 => quantity 0, value 0 (hardcoded, not derived)', () => {
    const current = pos('10', '1000');
    const { result, unitCostUzs, totalCostUzs } = depleteStock(
      current,
      new Prisma.Decimal('10'),
    );
    expect(result.quantity.toString()).toBe('0');
    expect(result.valueUzs.toString()).toBe('0');
    expect(unitCostUzs.toString()).toBe('100');
    expect(totalCostUzs.toString()).toBe('1000');
  });

  it('matches the worked example: current 10, out 11 => rejects with InsufficientStockError', () => {
    const current = pos('10', '1000');
    expect(() => depleteStock(current, new Prisma.Decimal('11'))).toThrow(
      InsufficientStockError,
    );
  });

  it('carries the available/requested quantities on the thrown error', () => {
    const current = pos('10', '1000');
    try {
      depleteStock(current, new Prisma.Decimal('11'));
      throw new Error('expected depleteStock to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InsufficientStockError);
      const insufficientStockError = error as InsufficientStockError;
      expect(insufficientStockError.available.toString()).toBe('10');
      expect(insufficientStockError.requested.toString()).toBe('11');
    }
  });

  it('full depletion lands on exactly zero even when the average has a repeating decimal', () => {
    // 10 / 3 = 3.333...; depleting the exact remaining 10 must still zero
    // out precisely, not leave a residual fraction from re-multiplying a
    // rounded average back out.
    const current = pos('3', '10');
    const { result } = depleteStock(current, new Prisma.Decimal('3'));
    expect(result.quantity.toString()).toBe('0');
    expect(result.valueUzs.toString()).toBe('0');
  });

  it('handles a fractional partial depletion exactly', () => {
    const current = pos('1.5', '150'); // average 100
    const { result, totalCostUzs } = depleteStock(
      current,
      new Prisma.Decimal('0.25'),
    );
    expect(totalCostUzs.toString()).toBe('25');
    expect(result.quantity.toString()).toBe('1.25');
    expect(result.valueUzs.toString()).toBe('125');
  });

  it('allows depleting a zero-cost position without dividing by zero', () => {
    const current = pos('5', '0');
    const { result, unitCostUzs, totalCostUzs } = depleteStock(
      current,
      new Prisma.Decimal('2'),
    );
    expect(unitCostUzs.toString()).toBe('0');
    expect(totalCostUzs.toString()).toBe('0');
    expect(result.quantity.toString()).toBe('3');
    expect(result.valueUzs.toString()).toBe('0');
  });
});
