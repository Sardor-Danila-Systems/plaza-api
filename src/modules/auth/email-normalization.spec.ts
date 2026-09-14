import { normalizeEmail } from './email-normalization.js';

describe('normalizeEmail', () => {
  it('lowercases the email', () => {
    expect(normalizeEmail('User@Example.com')).toBe('user@example.com');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeEmail('  user@example.com  ')).toBe('user@example.com');
  });

  it('is idempotent', () => {
    const once = normalizeEmail('  User@Example.com  ');
    expect(normalizeEmail(once)).toBe(once);
  });
});
