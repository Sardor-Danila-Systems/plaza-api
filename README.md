# Euro Plaza Management System — backend

Backend API for Euro Plaza Group's construction project management system.
**Current status: Phases 0-12 complete** — authentication, projects/
construction, the financial ledger, inventory (masters, purchases,
write-offs, transfers), suppliers/debt/advances, audit (write + read),
attachments (staged upload, local/S3 storage), analytics, XLSX reports, and
a production-hardening pass are all implemented and covered by real
PostgreSQL unit/e2e/concurrency/DB-constraint tests. See
[docs/backend-architecture.md](docs/backend-architecture.md) for the full
design and [docs/phase-0-review.md](docs/phase-0-review.md) for the
original design review. [CONTEXT.md](CONTEXT.md) is the domain glossary;
hard-to-reverse decisions are recorded individually in
[docs/adr/](docs/adr/).

Not implemented (explicitly out of scope through Phase 13 — see the final
Phase 5-13 report for the complete list): a full audit-attachment UI beyond
the REST API itself, and any frontend. There is no Phase 14+ work planned
beyond this point without new instructions.

## Prerequisites

- Node.js 24+ (developed against Node 26)
- PostgreSQL 14+ reachable locally (native install or Docker — see below)
- npm

## Install

```bash
npm install
```

`postinstall` runs `prisma generate` automatically. If you ever need to
regenerate the client by hand (e.g. after pulling a schema change):

```bash
npm run prisma:generate
```

## Environment

Copy the example file and fill in real values:

```bash
cp .env.example .env
```

| Variable            | Required | Meaning                                                                                |
| ------------------- | -------- | --------------------------------------------------------------------------------------- |
| `NODE_ENV`          | no       | `development` \| `production` \| `test`. Defaults to `development`.                     |
| `PORT`              | no       | HTTP port. Defaults to `3000`.                                                          |
| `DATABASE_URL`      | **yes**  | PostgreSQL connection string (`postgres://` or `postgresql://`).                        |
| `TEST_DATABASE_URL` | no       | Separate database used only by `npm run test:e2e` — see "Tests" below.                  |
| `CORS_ORIGIN`       | **yes, to use the frontend** | Comma-separated allowed origins, e.g. `http://localhost:3001` for local dev. Empty/unset disables CORS entirely — every browser request from the frontend is then silently rejected before it reaches any route. This is the single most common "works on my machine, not after a fresh clone" cause: `.env.example` ships a working local-dev value, but a `.env` copied from an older revision or edited by hand can lose it. |
| `SWAGGER_ENABLED`   | no       | `true`/`false`. Defaults to enabled outside `production`.                               |
| `LOG_LEVEL`         | no       | `error` \| `warn` \| `log` \| `debug` \| `verbose`. Defaults to `log`.                   |
| `JWT_ACCESS_SECRET` | **yes**  | ≥32 random characters. No fallback — startup fails without a real one. Generate with `openssl rand -base64 48`. |
| `JWT_ACCESS_TTL`    | no       | Access token lifetime, e.g. `15m`. Defaults to `15m`.                                   |
| `JWT_ISSUER`        | **yes**  | JWT `iss` claim, validated on every verification.                                       |
| `JWT_AUDIENCE`      | **yes**  | JWT `aud` claim, validated on every verification.                                       |
| `REFRESH_TOKEN_TTL` | no       | Refresh session absolute lifetime, e.g. `30d`. Defaults to `30d`.                        |
| `STORAGE_DRIVER`     | no       | `local` \| `s3`. Defaults to `local`. See [Attachment storage](#attachment-storage) below.          |
| `STORAGE_LOCAL_ROOT` | no       | Filesystem directory for the `local` driver. Defaults to `./storage/attachments`.        |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_FORCE_PATH_STYLE` | only for `s3` | Any S3-compatible endpoint (real AWS S3, MinIO, Supabase Storage). `S3_FORCE_PATH_STYLE=true` for MinIO/Supabase-style endpoints. |
| `ATTACHMENT_MAX_SIZE_BYTES` | no | Per-file upload limit. Defaults to `10485760` (10 MiB).                                |
| `ATTACHMENT_ORPHAN_TTL` | no    | How long a never-linked upload survives before the orphan-cleanup job may remove it. Defaults to `24h`. |

Startup fails fast with a readable error if any variable is missing or
malformed — see `src/config/env.validation.ts`. Real secrets never belong in
`.env.example`, and `.env`/`.env.test` are gitignored.

## PostgreSQL setup

Any reachable PostgreSQL 14+ instance works. Two options:

**Local install** (what this repo was developed against):

```bash
createdb plaza_backend_dev
createdb plaza_backend_test   # used only by e2e tests
```

**Docker**, if you don't want a local install:

```bash
docker run --name plaza-postgres -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 -d postgres:16
docker exec plaza-postgres createdb -U postgres plaza_backend_dev
docker exec plaza-postgres createdb -U postgres plaza_backend_test
```

Point `DATABASE_URL`/`TEST_DATABASE_URL` at whichever you chose.

**Neon** (managed Postgres, used for shared/deployed environments): create a
project at [neon.tech](https://neon.tech), copy its **pooled connection
string** (already includes `?sslmode=require`) into `DATABASE_URL`. No
`DIRECT_URL` is needed — this app uses `@prisma/adapter-pg` with a single
connection string for both `prisma migrate` and runtime queries, and Neon's
pooler supports both. Run migrations once against it (`npm run
prisma:migrate:deploy`) and, if it's a fresh database, seed it (`npm run
seed`) — an empty database is indistinguishable from a "broken" one from the
UI (empty charts, empty lists), so confirm data exists before assuming
anything else is wrong.

## Prisma

This project uses **Prisma ORM v7** (pinned; v8 is a release candidate as of
this writing — see [docs/phase-0-review.md](docs/phase-0-review.md) for the
version research). `prisma/schema.prisma` currently defines: `Role`, `Project`
(now with its full Phase 3 identity — `timezone` included; `postingSequence`
still deferred to Phase 4, its only consumer), `User`, `RefreshSession`,
`RefreshToken`, `BuildingBlock`, `Floor`. Each later phase adds the model
group it owns (see the phased plan in
[docs/backend-architecture.md §12](docs/backend-architecture.md)). Three
constraints Prisma's schema language can't express (or can only express
behind a preview feature this project avoids) are hand-added to migration
SQL:

- `User_role_projectId_check` / `User_email_lowercase_check` — cross-column
  CHECK constraints ([ADR 0008](docs/adr/0008-manual-sql-check-constraints.md)).
- `User_one_active_manager_per_project` — a partial unique index enforcing
  "at most one active PROJECT_MANAGER per project" without blocking a
  deactivated former manager from keeping their historical assignment
  ([ADR 0013](docs/adr/0013-project-manager-relation.md)).

```bash
npm run prisma:validate       # validate prisma/schema.prisma
npm run prisma:generate       # regenerate the client into src/generated/prisma
npm run prisma:migrate:dev    # development: create + apply a migration
npm run prisma:migrate:deploy # production: apply pending migrations only
```

Never use `prisma db push` as the migration strategy (see
[docs/backend-architecture.md §5](docs/backend-architecture.md)) — always go
through `migrate dev`/`migrate deploy` so schema history is reviewable and
replayable.

The generated client lives at `src/generated/prisma/` and is gitignored
(regenerated by `postinstall` / `npm run prisma:generate`) — it is TypeScript
source, not prebuilt JS, so it must exist before `npm run typecheck`/`build`
will succeed after a clean clone.

## Seed / account provisioning

There is no self-registration endpoint, and no `POST /projects` either — no
role in this system is a legitimate project administrator (OWNER/ACCOUNTANT
are read-only by product requirement; PROJECT_MANAGER can only mutate the one
project they're already assigned to). See
[ADR 0014](docs/adr/0014-project-provisioning-outside-http-api.md).

**Development seed** — accounts and three example projects:

```bash
npm run seed
```

Refuses to run when `NODE_ENV=production`. Creates one `OWNER`, one
`ACCOUNTANT`, and one `PROJECT_MANAGER` (assigned to "Avenue Plaza"; two more
unmanaged example projects, "Margilon Plaza" and "Palma Plaza", are also
created), all using a clearly-labeled dev-only default password
(`ChangeMe123!DevOnly`) unless overridden:

```bash
SEED_OWNER_PASSWORD=... SEED_ACCOUNTANT_PASSWORD=... SEED_MANAGER_PASSWORD=... npm run seed
```

Safe to re-run (upserts by email/code).

**Operator provisioning CLI** — creating a project or assigning/reassigning
its manager, in any environment (including production):

```bash
npm run build   # required first — see ADR 0015 below
npm run provision -- create-project --name "Avenue Plaza" --code avenue-plaza
npm run provision -- assign-manager --project avenue-plaza --user manager@example.com
npm run provision -- set-role --user someone@example.com --role ACCOUNTANT
npm run provision -- set-role --user someone@example.com --role PROJECT_MANAGER --project avenue-plaza
npm run provision -- rename-project --project avenue-plaza --name "Avenue Plaza (renamed)"
```

Project/user may be identified by UUID or by code/email. Reassigning a
project's manager deactivates whoever currently holds it (their historical
`role`/`projectId` are never rewritten — see
[ADR 0013](docs/adr/0013-project-manager-relation.md)) and activates the new
one; because `JwtAuthGuard` already re-checks `isActive` on every request
(Phase 2), the outgoing manager's existing access token stops granting
project access on their very next request, with no separate revocation step.

`npm run provision` **must** run from the compiled `dist/` output, not
`tsx` — see
[ADR 0015](docs/adr/0015-cli-tools-requiring-nest-di-must-run-compiled.md)
for why (a real, empirically-verified incompatibility between `tsx`/esbuild
and Nest's constructor-based dependency injection). `npm run seed` is
unaffected and keeps using `tsx` — it never touches Nest's DI.

## Authentication

```
POST /auth/login    { email, password } -> { accessToken, user }
POST /auth/refresh  (no body)           -> { accessToken }
POST /auth/logout   (no body)           -> 204
GET  /auth/me                           -> the authenticated user
```

- **Access token**: short-lived JWT (`JWT_ACCESS_TTL`, default 15m), sent as
  `Authorization: Bearer <token>`. Every authenticated request re-validates
  the session and user from the database — a revoked session or disabled
  user is rejected immediately, not only once the JWT's own expiry passes
  (see [docs/adr/0009](docs/adr/0009-per-request-session-revalidation.md)).
- **Refresh token**: an opaque high-entropy secret delivered as an `HttpOnly`,
  `Secure` (in production), `SameSite=Lax` cookie scoped to `/auth`, rotated
  on every use. Only its SHA-256 hash is ever stored
  ([docs/adr/0010](docs/adr/0010-refresh-token-hash-lookup.md)). Reusing an
  already-rotated refresh token revokes the entire session
  ([docs/adr/0012](docs/adr/0012-refresh-rotation-concurrency.md)) — **never
  fire two refresh requests concurrently for the same session** (use a
  single-flight/mutex guard client-side around the refresh call).
- **CSRF**: `POST /auth/refresh` and `POST /auth/logout` also require an
  `X-CSRF-Token` header matching the non-`HttpOnly` `csrf_token` cookie set
  alongside the refresh cookie (double-submit pattern). `POST /auth/login`
  doesn't need this (it's protected by the password itself, not an ambient
  cookie).
- **Rate limiting**: a minimal in-process, single-instance limiter on
  `/auth/login` and `/auth/refresh` — **not** distributed rate limiting; see
  `AuthRateLimitGuard`'s doc comment for the upgrade path if this ever runs
  behind more than one instance.
- Swagger (`/docs`) documents all four routes, their request/response DTOs,
  the Bearer scheme, and the refresh cookie/CSRF requirement.

## Projects and construction

```
GET   /projects                                                       list (role-scoped)
GET   /projects/:projectId                                            read one
                                                                       (no PATCH — see below)

GET   /projects/:projectId/construction/blocks                        list
GET   /projects/:projectId/construction/blocks/:blockId                read one
POST  /projects/:projectId/construction/blocks                        create
PATCH /projects/:projectId/construction/blocks/:blockId                update / archive / restore

GET   /projects/:projectId/construction/blocks/:blockId/floors               list
GET   /projects/:projectId/construction/blocks/:blockId/floors/:floorId       read one
POST  /projects/:projectId/construction/blocks/:blockId/floors               create
PATCH /projects/:projectId/construction/blocks/:blockId/floors/:floorId       update / archive / restore
```

None of the routes above carry a path prefix beyond what's shown (no
`/api/v1`) — a documented correction to an internal inconsistency in
`docs/backend-architecture.md`'s earlier "all business routes are beneath
`/api/v1`" claim, which never matched what Phase 1/2 already shipped for
`/auth`/`/health`; see that document's Route Surface section for the full
correction.

- **Read**: OWNER/ACCOUNTANT see/read every active project; PROJECT_MANAGER
  sees/reads only their own assigned (active) project. List queries are
  filtered in the database, never fetched-then-filtered in JavaScript.
- **Write**: PROJECT_MANAGER only, and only within their own project's
  *operational content* (blocks, floors, and — from Phase 4 — finances/
  inventory/etc.), via `ProjectAccessService.assertAccess(user, projectId,
  WRITE)` (Phase 2), called by every mutating endpoint above. This does
  **not** extend to the project's own administrative identity — there is no
  `PATCH /projects/:projectId` (Phase 3.1 correction; a manager operating on
  their project's content does not imply authority to rename the project
  itself). Project rename/creation/manager-assignment all go through the CLI
  only — see "Seed / account provisioning" above and
  [ADR 0014](docs/adr/0014-project-provisioning-outside-http-api.md).
- **No hard delete anywhere**: blocks/floors use `isActive` (archive/restore
  via `PATCH`); a project's `code` and a block's `code` are immutable stable
  identifiers once created, never regenerated.
- **Nested resource integrity is enforced at the database level, not just in
  application code**: `Floor` composite-foreign-keys against
  `(projectId, blockId)`, so a floor referencing the right block ID but the
  wrong project ID is a foreign-key violation, not merely an application
  check. A block/floor that doesn't belong to the URL's project/block returns
  a 404 with a specific code (`BLOCK_PROJECT_MISMATCH`,
  `FLOOR_BLOCK_MISMATCH`, `FLOOR_PROJECT_MISMATCH`) rather than leaking
  whether the underlying record exists elsewhere.
- **An inactive project is invisible to everyone, including its own assigned
  manager** — no exception is made for the current manager once their
  project is deactivated (a documented, deliberately conservative Phase 3
  choice; see `docs/phase-0-review.md`'s Phase 3 findings).

## Development

```bash
npm run start:dev     # watch mode
npm run start          # single run
npm run start:prod     # run the compiled dist/ output
npm run build           # compile to dist/
```

- Health check: `GET http://localhost:3000/health` → `{"status":"ok","database":"up","timestamp":"..."}` (or `503` with the standard error shape if the database is unreachable — the application itself still stays up).
- Swagger UI: `http://localhost:3000/docs` (disable in production via `SWAGGER_ENABLED=false`).
- Frontend integration handoff: [docs/frontend-integration.md](docs/frontend-integration.md).

## Tests

```bash
npm test            # unit tests (Jest)
npm run test:cov     # unit tests with coverage
npm run test:e2e     # integration/e2e tests against a real PostgreSQL database
```

**Why Jest runs under `--experimental-vm-modules`:** this project is native
ESM (`"type": "module"`), and Prisma ORM v7's generated client uses
`import.meta.url` internally, which does not exist under CommonJS — a
`require()`-based Jest setup cannot load it at all. `npm test`/`npm run
test:e2e` already pass the required Node flag; you do not need to set
anything yourself. See `jest.config.js` and
[docs/adr/0007-prisma-client-composition-not-inheritance.md](docs/adr/0007-prisma-client-composition-not-inheritance.md)
for the underlying finding.

**e2e tests use a real PostgreSQL database, never a mocked Prisma client**
(required by [docs/backend-architecture.md §12](docs/backend-architecture.md)
for every transaction-critical workflow). Set `TEST_DATABASE_URL` (see
`.env.example`) to a database you don't mind being used destructively —
`.env.test` is loaded automatically when `NODE_ENV=test` (which Jest sets by
default). No Docker/Testcontainers dependency was added: a plain local/CI
PostgreSQL instance is sufficient and simpler; revisit this only if
per-worker test-database isolation becomes a real need in a later phase.

This includes a real concurrency test
(`test/auth-concurrency.e2e-spec.ts`) that fires two simultaneous
`POST /auth/refresh` requests presenting the same token against real
Postgres and asserts exactly one succeeds — proving the atomic
conditional-update rotation guard, not just asserting it exists.

## Lint, format, typecheck

```bash
npm run lint          # oxlint
npm run format         # prettier --write
npm run format:check   # prettier --check (used in CI)
npm run typecheck      # tsc --noEmit
```

## Attachment storage

Two adapters behind one `StorageService` interface
(`src/modules/attachments/storage/`): a local-filesystem adapter (default,
for dev/test/single-box deployments) and an S3-compatible adapter (any
provider that speaks the S3 API — real AWS S3, MinIO, Supabase Storage).
Select via `STORAGE_DRIVER`. Files are staged `PENDING -> READY -> LINKED`
(or `FAILED`) — see `docs/backend-architecture.md` §10 and
`AttachmentsService`'s own doc comment for the exact state machine and why
storage and PostgreSQL never share a transaction.

Never-linked uploads (abandoned or failed) expire after
`ATTACHMENT_ORPHAN_TTL` and become eligible for `AttachmentsCleanupService
.cleanupExpired()`. **This is not wired to a live scheduler** — no
scheduling dependency exists elsewhere in this codebase, so none was added
for this one job. Call it periodically from a deployment-level cron (or via
`@nestjs/schedule` if a scheduler is ever adopted for other reasons too).

## Project structure

```text
src/
  main.ts              bootstrap: creates the app, wires Swagger, listens
  setup-app.ts          shared request pipeline (middleware/pipes/filters/
                         CORS/shutdown hooks) used by BOTH main.ts and e2e tests,
                         so tests exercise the real production configuration
  app.module.ts
  modules/
    health/             GET /health (public, no auth required)
    auth/               login/refresh/logout/me, JWT + refresh-session
                         rotation, password hashing, role/CSRF/rate-limit
                         guards — see "Authentication" above
    projects/           GET/PATCH /projects; ProjectAccessService (the
                         project-scoped READ/WRITE authorization primitive
                         every project-scoped controller calls);
                         ProjectProvisioningService (CLI-only, see
                         "Seed / account provisioning" above)
    construction/
      blocks/            building blocks: list/read/create/update
      floors/            floors within a block: list/read/create/update
  common/
    filters/            AllExceptionsFilter — the one place errors become
                         the stable { statusCode, error, code, message,
                         path, timestamp, requestId } response shape
    interceptors/        LoggingInterceptor — one log line per request,
                         deliberately logging no headers/body/query values
    middleware/          request ID assignment/propagation
    dto/                 shared response DTOs (Swagger)
  config/                validated typed environment configuration
  database/              PrismaService/PrismaModule
  cli/                    operator CLI entry points (compiled + run from
                         dist/ only — see ADR 0015; not part of the HTTP app)
  generated/prisma/       Prisma client (gitignored, regenerated)

prisma/
  seed.ts                 development-only seed (tsx; no Nest DI)
```

`modules/` will grow one feature at a time following the phased plan; see
[docs/backend-architecture.md](docs/backend-architecture.md) for what each
upcoming phase owns.
