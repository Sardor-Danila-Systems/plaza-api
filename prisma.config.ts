import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma ORM v7 configuration. Connection details live here, not in
// prisma/schema.prisma (see docs/phase-0-review.md for the version research
// behind pinning prisma@7.10.0). DATABASE_URL itself is validated at
// application startup by src/config/env.validation.ts; this file only wires
// the same variable into the Prisma CLI for `generate`/`migrate`/`validate`.
//
// Deliberately NOT `prisma/config`'s own `env('DATABASE_URL')` helper here:
// that throws synchronously the instant this file is loaded if the variable
// is unset, and this file loads on every `prisma` CLI invocation —
// including the `postinstall: prisma generate` hook in package.json, which
// runs during `npm install`, before a fresh clone has ever had the chance
// to create a `.env` from `.env.example`. That turned "clone, npm install"
// into a hard failure for anyone who hadn't already configured `.env` first
// — reproduced empirically: `npm install` on a bare clone fails at
// `postinstall` with "Cannot resolve environment variable: DATABASE_URL".
// `prisma generate` never actually connects to the database (verified: it
// succeeds against a syntactically-valid but unreachable URL), so a
// placeholder here is safe — it only ever matters for `generate`; real
// commands (`migrate deploy`, the app itself) require a real `.env` with a
// real DATABASE_URL regardless, enforced independently by
// src/config/env.validation.ts at application startup.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // Development-only provisioning (docs/backend-architecture.md §2's
    // "controlled seed/admin/CLI workflow", never auto-run in production —
    // see prisma/seed.ts's own NODE_ENV=production guard). Prisma v7 no
    // longer auto-seeds on `migrate dev`; invoke explicitly via `npm run seed`.
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url:
      process.env.DATABASE_URL ??
      'postgresql://placeholder:placeholder@localhost:5432/placeholder',
  },
});
