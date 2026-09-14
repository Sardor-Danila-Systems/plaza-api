import { randomBytes, createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppConfigService } from '../../config/app-config.service.js';
import { parseDurationMs } from '../../config/duration.util.js';
import { Role } from '../../generated/prisma/client.js';

/** The access token's exact claim set — never passwordHash, never a full
 * user record, never a permission object (docs/backend-architecture.md §6). */
export interface AccessTokenPayload {
  sub: string;
  sid: string;
  role: Role;
}

const REFRESH_SECRET_BYTES = 32;
/** Explicit allow-list: never accept a token signed with a different
 * algorithm (or `none`) than the one this service signs with. */
const JWT_ALGORITHM = 'HS256';

@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: AppConfigService,
  ) {}

  async signAccessToken(payload: AccessTokenPayload): Promise<string> {
    return this.jwtService.signAsync(payload, {
      secret: this.config.jwtAccessSecret,
      // A plain number of seconds (not the validated "15m"-style string)
      // sidesteps jsonwebtoken's `StringValue` branded-string type, which a
      // dynamically-loaded config string can't satisfy structurally even
      // though env.validation.ts already constrains its format.
      expiresIn: Math.floor(parseDurationMs(this.config.jwtAccessTtl) / 1000),
      issuer: this.config.jwtIssuer,
      audience: this.config.jwtAudience,
      algorithm: JWT_ALGORITHM,
    });
  }

  /** Throws (does not return null) on any invalid/expired/malformed/
   * wrong-algorithm token — callers map the specific jsonwebtoken error to a
   * stable code; the raw library error never reaches a client. */
  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    return this.jwtService.verifyAsync<AccessTokenPayload>(token, {
      secret: this.config.jwtAccessSecret,
      issuer: this.config.jwtIssuer,
      audience: this.config.jwtAudience,
      algorithms: [JWT_ALGORITHM],
    });
  }

  /** A fresh high-entropy refresh secret and the hash that gets persisted.
   * The secret itself is returned to the caller exactly once, to become the
   * cookie value — see docs/adr/0010-refresh-token-hash-lookup.md for why a
   * fast deterministic hash is the correct (not weakened) choice here. */
  generateRefreshSecret(): { secret: string; hash: string } {
    const secret = randomBytes(REFRESH_SECRET_BYTES).toString('base64url');
    return { secret, hash: this.hashRefreshSecret(secret) };
  }

  hashRefreshSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  generateCsrfToken(): string {
    return randomBytes(REFRESH_SECRET_BYTES).toString('base64url');
  }
}
