import { Type, plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

/**
 * Environment names the application recognizes. Kept in `common/enums` would
 * suggest business meaning; this is purely a runtime-mode switch, so it lives
 * next to the validation it drives.
 */
export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

/**
 * The full set of environment variables the application reads, with the
 * validation each one must satisfy before the process is allowed to start.
 * `class-validator`/`class-transformer` are the same libraries later phases
 * use for request DTOs (see docs/backend-architecture.md §9) — Phase 1
 * deliberately does not introduce a second schema library (Joi/Zod) for this.
 */
class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  // Explicit @Type(), not reliance on `enableImplicitConversion`'s automatic
  // design:type reflection: that automatic path silently does nothing when
  // this file is compiled by a transformer that doesn't emit
  // `emitDecoratorMetadata` output (esbuild/tsx, used by prisma/seed.ts and
  // scripts/*.ts — verified empirically: PORT arrived as the *string* "3000"
  // and failed IsInt/Min/Max simultaneously under tsx even though the exact
  // same code path works under tsc's dist/ build and under @swc/jest). An
  // explicit @Type() does not depend on that metadata at all, so it works
  // identically everywhere this class is used.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsString()
  @Matches(/^postgres(ql)?:\/\//, {
    message:
      'DATABASE_URL must be a postgres:// or postgresql:// connection string',
  })
  DATABASE_URL!: string;

  @IsOptional()
  @IsString()
  @Matches(/^postgres(ql)?:\/\//, {
    message:
      'TEST_DATABASE_URL must be a postgres:// or postgresql:// connection string',
  })
  TEST_DATABASE_URL?: string;

  @IsOptional()
  @IsString()
  CORS_ORIGIN?: string;

  @IsOptional()
  @IsEnum(['true', 'false'] as const)
  SWAGGER_ENABLED?: 'true' | 'false';

  @IsOptional()
  @IsEnum(['error', 'warn', 'log', 'debug', 'verbose'] as const)
  LOG_LEVEL?: 'error' | 'warn' | 'log' | 'debug' | 'verbose';

  // --- Phase 2: authentication ---

  /** Never hardcode a fallback here — a missing secret must fail startup. */
  @IsString()
  @MinLength(32, {
    message: 'JWT_ACCESS_SECRET must be at least 32 characters',
  })
  JWT_ACCESS_SECRET!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+[smhd]$/, {
    message: 'JWT_ACCESS_TTL must look like "15m", "1h", "1d", or "30s"',
  })
  JWT_ACCESS_TTL: string = '15m';

  @IsString()
  JWT_ISSUER!: string;

  @IsString()
  JWT_AUDIENCE!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+[smhd]$/, {
    message:
      'REFRESH_TOKEN_TTL must look like "30d", "12h", "1440m", or "2592000s"',
  })
  REFRESH_TOKEN_TTL: string = '30d';

  // --- Phase 9: attachment storage ---

  /** `local` (default — a plain filesystem directory, for dev/test/single-box
   * deployments) or `s3` (any S3-compatible endpoint — real AWS S3, MinIO,
   * Supabase Storage — docs/backend-architecture.md §10: "a real
   * local-filesystem development adapter and a real S3-compatible
   * deployment adapter behind the small storage interface"). */
  @IsOptional()
  @IsEnum(['local', 's3'] as const)
  STORAGE_DRIVER: 'local' | 's3' = 'local';

  /** Only read when `STORAGE_DRIVER=local`. Relative paths resolve against
   * the process's current working directory. */
  @IsOptional()
  @IsString()
  STORAGE_LOCAL_ROOT: string = './storage/attachments';

  @IsOptional()
  @IsString()
  S3_ENDPOINT?: string;

  @IsOptional()
  @IsString()
  S3_REGION?: string;

  @IsOptional()
  @IsString()
  S3_BUCKET?: string;

  @IsOptional()
  @IsString()
  S3_ACCESS_KEY_ID?: string;

  @IsOptional()
  @IsString()
  S3_SECRET_ACCESS_KEY?: string;

  /** `true` for MinIO/Supabase-style endpoints that expect
   * `https://host/bucket/key` rather than AWS's own `https://bucket.host/key`
   * virtual-hosted addressing. */
  @IsOptional()
  @IsEnum(['true', 'false'] as const)
  S3_FORCE_PATH_STYLE?: 'true' | 'false';

  /** Upper bound on one uploaded attachment (docs/backend-architecture.md
   * §10: "up to a configured limit (initially 10 MiB)"). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  ATTACHMENT_MAX_SIZE_BYTES: number = 10 * 1024 * 1024;

  /** How long a never-linked (`PENDING`/`READY`/`FAILED`) attachment may
   * exist before the orphan cleanup job may remove it. */
  @IsOptional()
  @IsString()
  @Matches(/^\d+[smhd]$/, {
    message: 'ATTACHMENT_ORPHAN_TTL must look like "24h", "7d", or "3600s"',
  })
  ATTACHMENT_ORPHAN_TTL: string = '24h';
}

/**
 * `ConfigModule.forRoot({ validate })` hook: fails application startup with a
 * readable error listing every invalid/missing variable, rather than letting
 * the process boot with `undefined` values that later surface as confusing
 * runtime errors deep inside a business workflow. This is intentionally
 * synchronous and throws — there is no valid partially-configured state for
 * this application to run in.
 */
export function validate(
  config: Record<string, unknown>,
): EnvironmentVariables {
  // No `enableImplicitConversion`: that option's automatic type coercion
  // depends on TypeScript's `emitDecoratorMetadata` output, which not every
  // toolchain that runs this file produces (see PORT's `@Type()` comment
  // above). Every field that needs conversion declares it explicitly instead,
  // so this works identically regardless of how the file was compiled.
  const validated = plainToInstance(EnvironmentVariables, config);

  const errors = validateSync(validated, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    const details = errors
      .map((error) => Object.values(error.constraints ?? {}).join('; '))
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return validated;
}

export { EnvironmentVariables };
