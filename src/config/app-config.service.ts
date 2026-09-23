import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseDurationMs } from './duration.util.js';
import { EnvironmentVariables, NodeEnv } from './env.validation.js';

/**
 * Typed accessor over the validated environment (see env.validation.ts).
 * Business/infrastructure code should depend on this, not on
 * `ConfigService.get('SOME_STRING_KEY')` directly — that keeps every call
 * site protected by the same validation and gives one place to change if an
 * environment variable's name or shape ever changes.
 */
@Injectable()
export class AppConfigService {
  constructor(
    private readonly configService: ConfigService<EnvironmentVariables, true>,
  ) {}

  get nodeEnv(): NodeEnv {
    return this.configService.get('NODE_ENV', { infer: true });
  }

  get isProduction(): boolean {
    return this.nodeEnv === NodeEnv.Production;
  }

  get isTest(): boolean {
    return this.nodeEnv === NodeEnv.Test;
  }

  get port(): number {
    return this.configService.get('PORT', { infer: true });
  }

  get databaseUrl(): string {
    return this.configService.get('DATABASE_URL', { infer: true });
  }

  /** Parsed, trimmed list of allowed CORS origins. Empty means CORS is disabled. */
  get corsOrigins(): string[] {
    const raw = this.configService.get('CORS_ORIGIN', { infer: true });
    if (!raw) return [];
    return raw
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
  }

  get swaggerEnabled(): boolean {
    const raw = this.configService.get('SWAGGER_ENABLED', { infer: true });
    if (raw === undefined) return !this.isProduction;
    return raw === 'true';
  }

  get logLevel(): 'error' | 'warn' | 'log' | 'debug' | 'verbose' {
    return this.configService.get('LOG_LEVEL', { infer: true }) ?? 'log';
  }

  // --- Phase 2: authentication ---

  get jwtAccessSecret(): string {
    return this.configService.get('JWT_ACCESS_SECRET', { infer: true });
  }

  get jwtAccessTtl(): string {
    return this.configService.get('JWT_ACCESS_TTL', { infer: true });
  }

  get jwtIssuer(): string {
    return this.configService.get('JWT_ISSUER', { infer: true });
  }

  get jwtAudience(): string {
    return this.configService.get('JWT_AUDIENCE', { infer: true });
  }

  get refreshTokenTtlMs(): number {
    return parseDurationMs(
      this.configService.get('REFRESH_TOKEN_TTL', { infer: true }),
    );
  }

  /** `secure` cookie flag: required in production (HTTPS), relaxed for local HTTP dev. */
  get useSecureCookies(): boolean {
    // SameSite=None is only honored on a secure cookie, so asking for it
    // implies HTTPS even outside production.
    return this.isProduction || this.cookieSameSite === 'none';
  }

  /** See COOKIE_SAMESITE in src/config/env.validation.ts. */
  get cookieSameSite(): 'lax' | 'none' {
    return this.configService.get('COOKIE_SAMESITE', { infer: true }) ?? 'lax';
  }

  // --- Phase 9: attachment storage ---

  get storageDriver(): 'local' | 's3' {
    return this.configService.get('STORAGE_DRIVER', { infer: true });
  }

  get storageLocalRoot(): string {
    return this.configService.get('STORAGE_LOCAL_ROOT', { infer: true });
  }

  get s3Endpoint(): string | undefined {
    return this.configService.get('S3_ENDPOINT', { infer: true });
  }

  get s3Region(): string | undefined {
    return this.configService.get('S3_REGION', { infer: true });
  }

  get s3Bucket(): string | undefined {
    return this.configService.get('S3_BUCKET', { infer: true });
  }

  get s3AccessKeyId(): string | undefined {
    return this.configService.get('S3_ACCESS_KEY_ID', { infer: true });
  }

  get s3SecretAccessKey(): string | undefined {
    return this.configService.get('S3_SECRET_ACCESS_KEY', { infer: true });
  }

  get s3ForcePathStyle(): boolean {
    return (
      this.configService.get('S3_FORCE_PATH_STYLE', { infer: true }) === 'true'
    );
  }

  get attachmentMaxSizeBytes(): number {
    return this.configService.get('ATTACHMENT_MAX_SIZE_BYTES', { infer: true });
  }

  get attachmentOrphanTtlMs(): number {
    return parseDurationMs(
      this.configService.get('ATTACHMENT_ORPHAN_TTL', { infer: true }),
    );
  }
}
