import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AppConfigService } from '../../../config/app-config.service.js';
import { CsrfGuard } from './csrf.guard.js';

function createContext(options: {
  cookies?: Record<string, string>;
  headers?: Record<string, string | string[]>;
}) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        cookies: options.cookies ?? {},
        headers: options.headers ?? {},
      }),
    }),
  } as unknown as ExecutionContext;
}

function buildGuard(corsOrigins: string[] = []): CsrfGuard {
  return new CsrfGuard({ corsOrigins } as AppConfigService);
}

describe('CsrfGuard', () => {
  it('allows a request whose header matches the cookie (double-submit)', () => {
    const guard = buildGuard();
    const context = createContext({
      cookies: { csrf_token: 'abc123' },
      headers: { 'x-csrf-token': 'abc123' },
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects a missing CSRF cookie', () => {
    const guard = buildGuard();
    const context = createContext({ headers: { 'x-csrf-token': 'abc123' } });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('rejects a missing CSRF header', () => {
    const guard = buildGuard();
    const context = createContext({ cookies: { csrf_token: 'abc123' } });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('rejects a header that does not match the cookie', () => {
    const guard = buildGuard();
    const context = createContext({
      cookies: { csrf_token: 'abc123' },
      headers: { 'x-csrf-token': 'not-the-same-value' },
    });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('rejects a duplicated header value (array) even if one entry matches', () => {
    const guard = buildGuard();
    const context = createContext({
      cookies: { csrf_token: 'abc123' },
      headers: { 'x-csrf-token': ['abc123', 'abc123'] },
    });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('allows any origin when no CORS_ORIGIN is configured', () => {
    const guard = buildGuard([]);
    const context = createContext({
      cookies: { csrf_token: 'abc123' },
      headers: { 'x-csrf-token': 'abc123', origin: 'https://anything.example' },
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects a disallowed origin once CORS_ORIGIN is configured', () => {
    const guard = buildGuard(['https://app.example']);
    const context = createContext({
      cookies: { csrf_token: 'abc123' },
      headers: { 'x-csrf-token': 'abc123', origin: 'https://evil.example' },
    });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('allows the configured origin', () => {
    const guard = buildGuard(['https://app.example']);
    const context = createContext({
      cookies: { csrf_token: 'abc123' },
      headers: { 'x-csrf-token': 'abc123', origin: 'https://app.example' },
    });
    expect(guard.canActivate(context)).toBe(true);
  });
});
