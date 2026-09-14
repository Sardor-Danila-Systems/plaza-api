import { validate } from './env.validation.js';

describe('validate (environment configuration)', () => {
  const validConfig = {
    NODE_ENV: 'development',
    PORT: '3000',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    JWT_ACCESS_SECRET: 'a-test-secret-that-is-at-least-32-characters-long',
    JWT_ISSUER: 'test-issuer',
    JWT_AUDIENCE: 'test-audience',
  };

  it('accepts a valid configuration and coerces PORT to a number', () => {
    const result = validate(validConfig);
    expect(result.PORT).toBe(3000);
    expect(result.NODE_ENV).toBe('development');
    expect(result.DATABASE_URL).toBe(validConfig.DATABASE_URL);
  });

  it('rejects a missing DATABASE_URL', () => {
    const { DATABASE_URL: _unused, ...rest } = validConfig;
    expect(() => validate(rest)).toThrow(/DATABASE_URL/);
  });

  it('rejects a DATABASE_URL that is not a postgres connection string', () => {
    expect(() =>
      validate({ ...validConfig, DATABASE_URL: 'mysql://localhost/db' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('rejects an out-of-range PORT', () => {
    expect(() => validate({ ...validConfig, PORT: '99999' })).toThrow();
  });

  it('rejects an unrecognized NODE_ENV', () => {
    expect(() => validate({ ...validConfig, NODE_ENV: 'staging' })).toThrow(
      /NODE_ENV/,
    );
  });

  it('defaults NODE_ENV and PORT when omitted', () => {
    const { NODE_ENV: _n, PORT: _p, ...rest } = validConfig;
    const result = validate(rest);
    expect(result.NODE_ENV).toBe('development');
    expect(result.PORT).toBe(3000);
  });

  it('rejects a missing JWT_ACCESS_SECRET (no insecure fallback)', () => {
    const { JWT_ACCESS_SECRET: _unused, ...rest } = validConfig;
    expect(() => validate(rest)).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('rejects a JWT_ACCESS_SECRET shorter than 32 characters', () => {
    expect(() =>
      validate({ ...validConfig, JWT_ACCESS_SECRET: 'too-short' }),
    ).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('rejects a malformed JWT_ACCESS_TTL', () => {
    expect(() =>
      validate({ ...validConfig, JWT_ACCESS_TTL: '15 minutes' }),
    ).toThrow(/JWT_ACCESS_TTL/);
  });

  it('rejects a malformed REFRESH_TOKEN_TTL', () => {
    expect(() =>
      validate({ ...validConfig, REFRESH_TOKEN_TTL: 'thirty days' }),
    ).toThrow(/REFRESH_TOKEN_TTL/);
  });

  it('defaults JWT_ACCESS_TTL and REFRESH_TOKEN_TTL when omitted', () => {
    const result = validate(validConfig);
    expect(result.JWT_ACCESS_TTL).toBe('15m');
    expect(result.REFRESH_TOKEN_TTL).toBe('30d');
  });
});
