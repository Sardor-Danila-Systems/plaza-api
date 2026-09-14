import { ExecutionContext, HttpException } from '@nestjs/common';
import { AuthRateLimitGuard } from './auth-rate-limit.guard.js';

function createContext(
  ip = '127.0.0.1',
  path = '/auth/login',
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ ip, method: 'POST', path }) }),
  } as unknown as ExecutionContext;
}

describe('AuthRateLimitGuard', () => {
  it('allows requests under the limit', () => {
    const guard = new AuthRateLimitGuard(3, 60_000);
    const context = createContext();
    expect(guard.canActivate(context)).toBe(true);
    expect(guard.canActivate(context)).toBe(true);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('blocks the request that exceeds the limit within the window', () => {
    const guard = new AuthRateLimitGuard(2, 60_000);
    const context = createContext();
    guard.canActivate(context);
    guard.canActivate(context);
    expect(() => guard.canActivate(context)).toThrow(HttpException);
    try {
      guard.canActivate(context);
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(429);
      expect((error as HttpException).getResponse()).toMatchObject({
        code: 'TOO_MANY_REQUESTS',
      });
    }
  });

  it('tracks different IPs independently', () => {
    const guard = new AuthRateLimitGuard(1, 60_000);
    expect(guard.canActivate(createContext('1.1.1.1'))).toBe(true);
    expect(guard.canActivate(createContext('2.2.2.2'))).toBe(true);
    expect(() => guard.canActivate(createContext('1.1.1.1'))).toThrow(
      HttpException,
    );
  });

  it('tracks different routes independently', () => {
    const guard = new AuthRateLimitGuard(1, 60_000);
    expect(guard.canActivate(createContext('1.1.1.1', '/auth/login'))).toBe(
      true,
    );
    expect(guard.canActivate(createContext('1.1.1.1', '/auth/refresh'))).toBe(
      true,
    );
  });

  it('resets the window after it elapses', () => {
    const guard = new AuthRateLimitGuard(1, 50);
    const context = createContext();
    expect(guard.canActivate(context)).toBe(true);
    expect(() => guard.canActivate(context)).toThrow(HttpException);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(guard.canActivate(context)).toBe(true);
        resolve();
      }, 60);
    });
  });
});
