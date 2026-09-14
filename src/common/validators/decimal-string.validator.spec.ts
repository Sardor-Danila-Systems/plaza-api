import { validate } from 'class-validator';
import { IsDecimalString } from './decimal-string.validator.js';

class MoneyDto {
  @IsDecimalString({ maxDecimalPlaces: 2 })
  amount!: string;
}

class RateDto {
  @IsDecimalString({ maxDecimalPlaces: 8 })
  rate!: string;
}

class NonNegativeDto {
  @IsDecimalString({ maxDecimalPlaces: 2, positive: false })
  amount!: string;
}

async function isValid(instance: object): Promise<boolean> {
  const errors = await validate(instance);
  return errors.length === 0;
}

describe('IsDecimalString', () => {
  it('accepts a whole number', async () => {
    const dto = new MoneyDto();
    dto.amount = '100';
    expect(await isValid(dto)).toBe(true);
  });

  it('accepts a value at the exact decimal-place limit', async () => {
    const dto = new MoneyDto();
    dto.amount = '100.50';
    expect(await isValid(dto)).toBe(true);
  });

  it('accepts a value with fewer than the maximum decimal places', async () => {
    const dto = new MoneyDto();
    dto.amount = '100.5';
    expect(await isValid(dto)).toBe(true);
  });

  it('accepts a small fractional value', async () => {
    const dto = new MoneyDto();
    dto.amount = '0.01';
    expect(await isValid(dto)).toBe(true);
  });

  it('rejects more decimal places than the destination column allows', async () => {
    const dto = new MoneyDto();
    dto.amount = '100.123';
    expect(await isValid(dto)).toBe(false);
  });

  it('rejects zero when positivity is required (default)', async () => {
    const dto = new MoneyDto();
    dto.amount = '0';
    expect(await isValid(dto)).toBe(false);
  });

  it('rejects a zero value expressed with fractional zeros', async () => {
    const dto = new MoneyDto();
    dto.amount = '0.00';
    expect(await isValid(dto)).toBe(false);
  });

  it('rejects a negative value', async () => {
    const dto = new MoneyDto();
    dto.amount = '-5.00';
    expect(await isValid(dto)).toBe(false);
  });

  it('rejects a leading plus sign', async () => {
    const dto = new MoneyDto();
    dto.amount = '+5.00';
    expect(await isValid(dto)).toBe(false);
  });

  it('rejects exponent notation', async () => {
    const dto = new MoneyDto();
    dto.amount = '1e3';
    expect(await isValid(dto)).toBe(false);
  });

  it('rejects a bare trailing decimal point', async () => {
    const dto = new MoneyDto();
    dto.amount = '5.';
    expect(await isValid(dto)).toBe(false);
  });

  it('rejects a leading decimal point with no integer part', async () => {
    const dto = new MoneyDto();
    dto.amount = '.5';
    expect(await isValid(dto)).toBe(false);
  });

  it('rejects a leading-zero integer part', async () => {
    const dto = new MoneyDto();
    dto.amount = '01';
    expect(await isValid(dto)).toBe(false);
  });

  it('rejects NaN/Infinity spellings', async () => {
    const dto = new MoneyDto();
    for (const value of ['NaN', 'Infinity', '-Infinity']) {
      dto.amount = value;
      expect(await isValid(dto)).toBe(false);
    }
  });

  it('rejects a non-string value', async () => {
    const dto = new MoneyDto();
    // @ts-expect-error deliberately violating the DTO's declared type
    dto.amount = 100;
    expect(await isValid(dto)).toBe(false);
  });

  it('supports an 8-decimal-place scale for rate fields', async () => {
    const dto = new RateDto();
    dto.rate = '12500.12345678';
    expect(await isValid(dto)).toBe(true);
  });

  it('rejects a 9th decimal place on an 8-decimal-place field', async () => {
    const dto = new RateDto();
    dto.rate = '12500.123456789';
    expect(await isValid(dto)).toBe(false);
  });

  it('allows zero when positive: false is set', async () => {
    const dto = new NonNegativeDto();
    dto.amount = '0';
    expect(await isValid(dto)).toBe(true);
  });

  it('still rejects a negative value when positive: false is set', async () => {
    const dto = new NonNegativeDto();
    dto.amount = '-1';
    expect(await isValid(dto)).toBe(false);
  });

  describe('maxTotalDigits (Phase 12 hardening)', () => {
    it('accepts a value at the default 24-total-digit limit (22 integer + 2 fractional)', async () => {
      const dto = new MoneyDto();
      dto.amount = '9999999999999999999999.99';
      expect(await isValid(dto)).toBe(true);
    });

    it('rejects a value with one more integer digit than the default 24-digit total allows — the exact case that used to reach PostgreSQL as a raw numeric overflow', async () => {
      const dto = new MoneyDto();
      dto.amount = '99999999999999999999999.99';
      expect(await isValid(dto)).toBe(false);
    });

    it('rejects an extreme value regardless of magnitude', async () => {
      const dto = new MoneyDto();
      dto.amount = '999999999999999999999999999999.00';
      expect(await isValid(dto)).toBe(false);
    });

    it('honors an explicit maxTotalDigits override', async () => {
      class WideDto {
        @IsDecimalString({ maxDecimalPlaces: 8, maxTotalDigits: 30 })
        value!: string;
      }
      const dto = new WideDto();
      dto.value = '99999999999999999999.12345678'; // 22 integer + 8 fractional = 30
      expect(await isValid(dto)).toBe(true);
    });
  });
});
