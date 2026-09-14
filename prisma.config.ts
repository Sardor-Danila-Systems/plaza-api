import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Prisma ORM v7 configuration. Connection details live here, not in
// prisma/schema.prisma (see docs/phase-0-review.md for the version research
// behind pinning prisma@7.10.0). DATABASE_URL itself is validated at
// application startup by src/config/env.validation.ts; this file only wires
// the same variable into the Prisma CLI for `generate`/`migrate`/`validate`.
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
    url: env('DATABASE_URL'),
  },
});
