import { computeRequestHash } from './request-hash.util.js';

describe('computeRequestHash', () => {
  it('is deterministic for the same payload', () => {
    const payload = { type: 'INCOME', amount: '100.00', currency: 'UZS' };
    expect(computeRequestHash(payload)).toBe(computeRequestHash(payload));
  });

  it('is independent of key order', () => {
    const a = { type: 'INCOME', amount: '100.00', currency: 'UZS' };
    const b = { currency: 'UZS', amount: '100.00', type: 'INCOME' };
    expect(computeRequestHash(a)).toBe(computeRequestHash(b));
  });

  it('treats an explicit undefined the same as an absent key', () => {
    const withUndefined = { type: 'INCOME', comment: undefined };
    const withoutKey = { type: 'INCOME' };
    expect(computeRequestHash(withUndefined)).toBe(
      computeRequestHash(withoutKey),
    );
  });

  it('produces a different hash for a different amount', () => {
    const a = { type: 'INCOME', amount: '100.00' };
    const b = { type: 'INCOME', amount: '100.01' };
    expect(computeRequestHash(a)).not.toBe(computeRequestHash(b));
  });

  it('distinguishes a decimal-string amount from a differently formatted equal value', () => {
    // Deliberately NOT normalized numerically — "100" and "100.00" are
    // different request bytes and must hash differently: the caller is
    // responsible for passing the validated canonical string (which
    // class-validator's DecimalString check already fixes at a known
    // scale), not this utility.
    const a = { amount: '100' };
    const b = { amount: '100.00' };
    expect(computeRequestHash(a)).not.toBe(computeRequestHash(b));
  });

  it('produces a different hash for nested object field order differences (still equal)', () => {
    const a = { nested: { x: 1, y: 2 } };
    const b = { nested: { y: 2, x: 1 } };
    expect(computeRequestHash(a)).toBe(computeRequestHash(b));
  });

  it('produces a 64-character lowercase hex digest', () => {
    const hash = computeRequestHash({ type: 'INCOME' });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
