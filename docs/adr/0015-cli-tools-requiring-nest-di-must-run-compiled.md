---
status: accepted
---

# Standalone tools that boot the real Nest application context must run from `dist/`, not via `tsx`

While building the Phase 3 operator provisioning CLI, booting `AppModule` through `tsx` (the same
tool `prisma/seed.ts` already used successfully) failed in two escalating ways: first,
`class-validator`'s environment validation rejected a perfectly valid `PORT=3000` because
`enableImplicitConversion` silently didn't convert the string, then — after fixing that with an
explicit `@Type(() => Number)` — Nest's own dependency injection failed to construct `PrismaService`
at all (`Cannot read properties of undefined (reading 'databaseUrl')`, its `AppConfigService`
constructor parameter arriving as `undefined`). Both symptoms trace to the same cause, confirmed by
directly comparing a `tsx`-run copy against a `tsc`-compiled copy of the identical code: `tsx` (via
esbuild) does not emit the `emitDecoratorMetadata` output (`design:paramtypes`/`design:type`
`Reflect.metadata(...)` calls) that both `class-transformer`'s implicit conversion and Nest's own
constructor-based dependency resolution depend on. `prisma/seed.ts` never hit this because it uses a
bare `PrismaClient` directly and has no `@Injectable()`/constructor-injected classes in its own
graph at all — it was accidentally immune, not a validated pattern to extend.

The fix is not a workaround inside application code: `src/config/env.validation.ts`'s numeric field
now declares `@Type(() => Number)` explicitly rather than relying on inferred metadata (a genuine
robustness improvement, unrelated to which tool runs it), and `src/cli/provision.ts` — anything that
boots `AppModule` and therefore exercises Nest's DI container — is compiled by the same `nest
build`/`tsc` pipeline as the real server and run with plain `node dist/cli/provision.js`, never
`tsx`. `prisma/seed.ts` is unaffected and keeps using `tsx`, since it never touches Nest's DI. Any
future standalone tool must make the same choice up front: no Nest DI at all (safe under `tsx`, like
the seed script), or Nest DI and therefore compiled output only.
