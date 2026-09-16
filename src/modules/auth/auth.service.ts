import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service.js';
import { PrismaService } from '../../database/prisma.service.js';
import { User } from '../../generated/prisma/client.js';
import { normalizeEmail } from './email-normalization.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

export interface LoginResult {
  accessToken: string;
  refreshSecret: string;
  csrfToken: string;
  user: User;
}

export interface RefreshResult {
  accessToken: string;
  refreshSecret: string;
  csrfToken: string;
}

/**
 * Orchestrates login/refresh/logout. Deliberately does not use the Phase 0
 * financial "project lock" transaction protocol (docs/transaction-design.md
 * §1) — auth sessions are independent of construction-project financial
 * state (per this phase's own instructions), and the narrower conditional-
 * update pattern below is the correct, minimal mechanism for the one race
 * that actually matters here (concurrent refresh-token reuse).
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly config: AppConfigService,
  ) {}

  async login(rawEmail: string, password: string): Promise<LoginResult> {
    const email = normalizeEmail(rawEmail);
    const user = await this.prisma.client.user.findUnique({ where: { email } });

    if (!user) {
      // Spend the same argon2 time a real verification would, so "unknown
      // email" and "wrong password" are indistinguishable by response
      // timing, not just by response body (see PasswordService).
      await this.passwordService.verifyAgainstDummyHash(password);
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    }

    const passwordValid = await this.passwordService.verify(
      user.passwordHash,
      password,
    );
    if (!passwordValid) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    }

    // Checked only AFTER a correct password: revealing "this account is
    // disabled" to someone who does not know the password would be a user
    // enumeration leak; revealing it to someone who already proved they know
    // the password is not (see docs/adr/0011-disabled-user-login-ordering.md).
    if (!user.isActive) {
      throw new ForbiddenException({
        code: 'USER_DISABLED',
        message: 'This account is disabled',
      });
    }

    const { secret: refreshSecret, hash: tokenHash } =
      this.tokenService.generateRefreshSecret();
    const expiresAt = new Date(Date.now() + this.config.refreshTokenTtlMs);

    const session = await this.prisma.client.$transaction(async (tx) => {
      const createdSession = await tx.refreshSession.create({
        data: { userId: user.id, expiresAt },
      });
      await tx.refreshToken.create({
        data: { sessionId: createdSession.id, tokenHash, expiresAt },
      });
      return createdSession;
    });

    const accessToken = await this.tokenService.signAccessToken({
      sub: user.id,
      sid: session.id,
      role: user.role,
    });

    this.logger.log(`User ${user.id} logged in (session ${session.id})`);

    return {
      accessToken,
      refreshSecret,
      csrfToken: this.tokenService.generateCsrfToken(),
      user,
    };
  }

  async refresh(refreshSecret: string): Promise<RefreshResult> {
    const tokenHash = this.tokenService.hashRefreshSecret(refreshSecret);

    const existingToken = await this.prisma.client.refreshToken.findUnique({
      where: { tokenHash },
      include: { session: { include: { user: true } } },
    });

    if (!existingToken) {
      throw new UnauthorizedException({
        code: 'INVALID_REFRESH_TOKEN',
        message: 'Invalid refresh token',
      });
    }

    if (existingToken.consumedAt !== null) {
      // Replay of an already-rotated token: assume compromise and burn the
      // whole session, not just this one token (docs/backend-architecture.md
      // §9 "reuse revokes the family").
      await this.revokeSession(
        existingToken.sessionId,
        'REFRESH_TOKEN_REUSE_DETECTED',
      );
      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_REVOKED',
        message: 'Refresh token has already been used',
      });
    }

    if (existingToken.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException({
        code: 'TOKEN_EXPIRED',
        message: 'Refresh token expired',
      });
    }

    if (existingToken.session.revokedAt !== null) {
      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_REVOKED',
        message: 'Session has been revoked',
      });
    }

    if (!existingToken.session.user.isActive) {
      throw new ForbiddenException({
        code: 'USER_DISABLED',
        message: 'This account is disabled',
      });
    }

    const { secret: newSecret, hash: newHash } =
      this.tokenService.generateRefreshSecret();

    const rotation = await this.prisma.client.$transaction(async (tx) => {
      // Re-read the session inside the transaction: closes the (narrow)
      // window between the reads above and this write where a concurrent
      // logout could have revoked it.
      const currentSession = await tx.refreshSession.findUnique({
        where: { id: existingToken.sessionId },
      });
      if (!currentSession || currentSession.revokedAt !== null) {
        return { outcome: 'session-revoked' as const };
      }

      // The atomic guard against concurrent reuse of the SAME token: this
      // UPDATE's WHERE clause only matches (and only one concurrent
      // transaction's UPDATE can ever match) a still-unconsumed row —
      // Postgres serializes concurrent UPDATEs to the same row at the row
      // level regardless of isolation level, so the loser reliably sees
      // `count: 0` once the winner commits. See
      // docs/adr/0012-refresh-rotation-concurrency.md.
      const consumeResult = await tx.refreshToken.updateMany({
        where: { id: existingToken.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      if (consumeResult.count === 0) {
        // The loser of a race against another request presenting the exact
        // same token. Deliberately treated identically to a delayed replay
        // (below) rather than "forgiven" as merely concurrent — see
        // docs/adr/0012-refresh-rotation-concurrency.md for why that
        // distinction turned out not to be reliably detectable, and why
        // industry-standard rotation (e.g. OAuth2 refresh token reuse
        // detection) burns the whole session on ANY reuse of a consumed
        // token rather than trying to guess intent from timing.
        await tx.refreshSession.updateMany({
          where: { id: existingToken.sessionId, revokedAt: null },
          data: {
            revokedAt: new Date(),
            revocationReason: 'REFRESH_TOKEN_REUSE_DETECTED',
          },
        });
        return { outcome: 'already-consumed' as const };
      }

      const newToken = await tx.refreshToken.create({
        data: {
          sessionId: existingToken.sessionId,
          tokenHash: newHash,
          expiresAt: currentSession.expiresAt,
        },
      });
      await tx.refreshToken.update({
        where: { id: existingToken.id },
        data: { replacedById: newToken.id },
      });

      return { outcome: 'rotated' as const };
    });

    if (rotation.outcome === 'session-revoked') {
      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_REVOKED',
        message: 'Session has been revoked',
      });
    }
    if (rotation.outcome === 'already-consumed') {
      // Lost a genuine concurrent-refresh race against another request using
      // the same token — not necessarily an attack, but the token is
      // single-use, so this attempt cannot succeed.
      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_REVOKED',
        message: 'Refresh token has already been used',
      });
    }

    const accessToken = await this.tokenService.signAccessToken({
      sub: existingToken.session.userId,
      sid: existingToken.session.id,
      role: existingToken.session.user.role,
    });

    return {
      accessToken,
      refreshSecret: newSecret,
      csrfToken: this.tokenService.generateCsrfToken(),
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.revokeSession(sessionId, 'LOGOUT');
  }

  /**
   * The only self-service profile field. `displayName` carries no
   * cross-row invariant (unlike email/role/projectId/isActive — see
   * UpdateMeDto's doc comment), so a plain allowlisted update is
   * sufficient; no transaction/audit machinery needed for this one field.
   */
  async updateDisplayName(userId: string, displayName: string): Promise<User> {
    const user = await this.prisma.client.user.update({
      where: { id: userId },
      data: { displayName },
    });
    this.logger.log(`User ${userId} updated their display name`);
    return user;
  }

  /**
   * Verifies the caller's current password, then rotates it and signs the
   * caller out of every OTHER session (their current device stays logged
   * in — the safer default without forcing an immediate re-login on the
   * device that just proved it knows both passwords).
   */
  async changePassword(
    userId: string,
    sessionId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.client.user.findUniqueOrThrow({
      where: { id: userId },
    });

    const currentValid = await this.passwordService.verify(
      user.passwordHash,
      currentPassword,
    );
    if (!currentValid) {
      throw new ConflictException({
        code: 'INVALID_CURRENT_PASSWORD',
        message: 'Current password is incorrect',
      });
    }

    const newPasswordHash = await this.passwordService.hash(newPassword);
    await this.prisma.client.user.update({
      where: { id: userId },
      data: { passwordHash: newPasswordHash },
    });

    await this.revokeAllOtherSessions(userId, sessionId, 'PASSWORD_CHANGE');
    this.logger.log(`User ${userId} changed their password`);
  }

  private async revokeSession(
    sessionId: string,
    reason: string,
  ): Promise<void> {
    // Idempotent: revoking an already-revoked session (e.g. a duplicate
    // logout, or reuse-detection racing a real logout) is not an error —
    // `updateMany` simply matches zero rows the second time.
    await this.prisma.client.refreshSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revocationReason: reason },
    });
  }

  /** Same idiom as revokeSession, scoped to a user and excluding one
   * session (the device making this request) — reuses the existing
   * `@@index([userId, revokedAt])` on RefreshSession. */
  private async revokeAllOtherSessions(
    userId: string,
    exceptSessionId: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.client.refreshSession.updateMany({
      where: { userId, revokedAt: null, id: { not: exceptSessionId } },
      data: { revokedAt: new Date(), revocationReason: reason },
    });
  }
}
