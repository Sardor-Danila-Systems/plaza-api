import {
  isFutureBusinessDate,
  isValidBusinessDate,
  todayInTimezone,
} from './business-date.util.js';

describe('isValidBusinessDate', () => {
  it('accepts a well-formed calendar date', () => {
    expect(isValidBusinessDate('2026-09-14')).toBe(true);
  });

  it('rejects a non-existent calendar date', () => {
    expect(isValidBusinessDate('2026-02-30')).toBe(false);
  });

  it('rejects a non-ISO format', () => {
    expect(isValidBusinessDate('09/14/2026')).toBe(false);
  });

  it('rejects a date with a time component', () => {
    expect(isValidBusinessDate('2026-09-14T00:00:00Z')).toBe(false);
  });

  it('accepts a leap day on a leap year', () => {
    expect(isValidBusinessDate('2024-02-29')).toBe(true);
  });

  it('rejects a leap day on a non-leap year', () => {
    expect(isValidBusinessDate('2026-02-29')).toBe(false);
  });
});

describe('todayInTimezone', () => {
  it('formats as YYYY-MM-DD', () => {
    const result = todayInTimezone(
      'Asia/Samarkand',
      new Date('2026-09-14T12:00:00Z'),
    );
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('reflects a later calendar day in a timezone ahead of UTC near midnight', () => {
    // 23:30 UTC on the 13th is 04:30 on the 14th in Asia/Samarkand (UTC+5).
    const result = todayInTimezone(
      'Asia/Samarkand',
      new Date('2026-09-13T23:30:00Z'),
    );
    expect(result).toBe('2026-09-14');
  });

  it('reflects an earlier calendar day in a timezone behind UTC near midnight', () => {
    // 02:00 UTC on the 14th is 21:00 on the 13th in America/New_York (UTC-5 in September... actually UTC-4 DST).
    const result = todayInTimezone(
      'America/New_York',
      new Date('2026-09-14T02:00:00Z'),
    );
    expect(result).toBe('2026-09-13');
  });
});

describe('isFutureBusinessDate', () => {
  const now = new Date('2026-09-14T12:00:00Z');

  it('is false for today', () => {
    expect(isFutureBusinessDate('2026-09-14', 'Asia/Samarkand', now)).toBe(
      false,
    );
  });

  it('is false for a past date', () => {
    expect(isFutureBusinessDate('2026-09-13', 'Asia/Samarkand', now)).toBe(
      false,
    );
  });

  it('is true for a future date', () => {
    expect(isFutureBusinessDate('2026-09-15', 'Asia/Samarkand', now)).toBe(
      true,
    );
  });
});
