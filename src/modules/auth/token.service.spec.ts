import { Test } from '@nestjs/testing';
import { JwtModule } from '@nestjs/jwt';
import { AppConfigService } from '../../config/app-config.service.js';
import { Role } from '../../generated/prisma/client.js';
import { TokenService } from './token.service.js';

function fakeConfig(
  overrides: Partial<AppConfigService> = {},
): AppConfigService {
  return {
    jwtAccessSecret: 'a-test-secret-that-is-at-least-32-characters-long',
    jwtAccessTtl: '15m',
    jwtIssuer: 'test-issuer',
    jwtAudience: 'test-audience',
    ...overrides,
  } as AppConfigService;
}

async function buildTokenService(
  config: AppConfigService,
): Promise<TokenService> {
  const moduleRef = await Test.createTestingModule({
    imports: [JwtModule.register({})],
    providers: [TokenService, { provide: AppConfigService, useValue: config }],
  }).compile();
  return moduleRef.get(TokenService);
}

describe('TokenService', () => {
  const payload = { sub: 'user-1', sid: 'session-1', role: Role.OWNER };

  it('signs and verifies a round trip with the exact claims', async () => {
    const service = await buildTokenService(fakeConfig());
    const token = await service.signAccessToken(payload);
    const verified = await service.verifyAccessToken(token);
    expect(verified).toMatchObject(payload);
  });

  it('never includes anything beyond sub/sid/role/standard claims', async () => {
    const service = await buildTokenService(fakeConfig());
    const token = await service.signAccessToken(payload);
    const [, payloadSegment] = token.split('.');
    const decoded = JSON.parse(
      Buffer.from(payloadSegment, 'base64url').toString('utf8'),
    );
    expect(Object.keys(decoded).sort()).toEqual([
      'aud',
      'exp',
      'iat',
      'iss',
      'role',
      'sid',
      'sub',
    ]);
  });

  it('rejects a token signed with a different secret', async () => {
    const tokenA = await (
      await buildTokenService(fakeConfig())
    ).signAccessToken(payload);
    const serviceB = await buildTokenService(
      fakeConfig({ jwtAccessSecret: 'a-completely-different-secret-32-chars' }),
    );
    await expect(serviceB.verifyAccessToken(tokenA)).rejects.toThrow();
  });

  it('rejects a token with the wrong issuer', async () => {
    const tokenA = await (
      await buildTokenService(fakeConfig())
    ).signAccessToken(payload);
    const serviceB = await buildTokenService(
      fakeConfig({ jwtIssuer: 'someone-else' }),
    );
    await expect(serviceB.verifyAccessToken(tokenA)).rejects.toThrow();
  });

  it('rejects a token with the wrong audience', async () => {
    const tokenA = await (
      await buildTokenService(fakeConfig())
    ).signAccessToken(payload);
    const serviceB = await buildTokenService(
      fakeConfig({ jwtAudience: 'someone-else' }),
    );
    await expect(serviceB.verifyAccessToken(tokenA)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const service = await buildTokenService(fakeConfig({ jwtAccessTtl: '1s' }));
    const token = await service.signAccessToken(payload);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(service.verifyAccessToken(token)).rejects.toThrow();
  });

  it('rejects a token forged with algorithm "none"', async () => {
    const service = await buildTokenService(fakeConfig());
    const header = Buffer.from(
      JSON.stringify({ alg: 'none', typ: 'JWT' }),
    ).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ ...payload, iss: 'test-issuer', aud: 'test-audience' }),
    ).toString('base64url');
    const forged = `${header}.${body}.`;
    await expect(service.verifyAccessToken(forged)).rejects.toThrow();
  });

  describe('refresh secrets', () => {
    it('generates a different secret and hash on every call', () => {
      const service = new TokenService({} as never, fakeConfig());
      const a = service.generateRefreshSecret();
      const b = service.generateRefreshSecret();
      expect(a.secret).not.toBe(b.secret);
      expect(a.hash).not.toBe(b.hash);
    });

    it('hashRefreshSecret is deterministic for the same input', () => {
      const service = new TokenService({} as never, fakeConfig());
      expect(service.hashRefreshSecret('same-secret')).toBe(
        service.hashRefreshSecret('same-secret'),
      );
    });

    it('never returns the secret itself as the hash', () => {
      const service = new TokenService({} as never, fakeConfig());
      const { secret, hash } = service.generateRefreshSecret();
      expect(hash).not.toBe(secret);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});
