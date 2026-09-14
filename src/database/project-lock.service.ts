import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';

/** The transaction client every workflow's callback receives — everything
 * on `PrismaClient` except the transaction-control methods themselves
 * (`$transaction`, `$connect`, ...), matching Prisma's own `TransactionClient`
 * type. Business services type their transaction-scoped helpers against
 * this, never against `PrismaService`/`PrismaClient` directly, so a helper
 * can never accidentally open its own independent transaction (see
 * docs/backend-architecture.md §6: "an internal helper must not open an
 * independent transaction or use the root client for part of a workflow").
 */
export type PrismaTx = Prisma.TransactionClient;

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 20;

/**
 * `true` for exactly the errors docs/transaction-design.md §2 marks
 * retryable: a Serializable-isolation write conflict or deadlock.
 *
 * Prisma's query-builder methods (e.g. `tx.project.update`) surface this
 * directly as `P2034`. Our own `$queryRaw` `SELECT ... FOR UPDATE`, however,
 * surfaces it as generic `P2010` ("raw query failed") whose real
 * classification is one level deeper still: `@prisma/adapter-pg` inspects
 * the raw PostgreSQL SQLSTATE itself (`40001` serialization failure,
 * `40P01` deadlock) and wraps EITHER one as
 * `meta.driverAdapterError.cause.kind === 'TransactionWriteConflict'` (see
 * `convertDriverError` in `@prisma/adapter-pg`) — confirmed by actually
 * printing this error's shape from a real concurrent-conflict run (this
 * project's concurrency test, test/finances-concurrency.e2e-spec.ts),
 * because Prisma's own error-code documentation does not describe this
 * adapter-specific nesting, and an assumption here — the raw SQLSTATE
 * appearing directly on `.code`, or under a flat `meta.code` — was tried
 * and empirically proven wrong before landing on this.
 */
function isRetryableError(error: unknown): boolean {
  if (
    typeof error !== 'object' ||
    error === null ||
    (error as { name?: unknown }).name !== 'PrismaClientKnownRequestError'
  ) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (code === 'P2034') {
    return true;
  }
  if (code === 'P2010') {
    const driverAdapterError = (
      error as {
        meta?: { driverAdapterError?: { cause?: { kind?: unknown } } };
      }
    ).meta?.driverAdapterError;
    return driverAdapterError?.cause?.kind === 'TransactionWriteConflict';
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The project-lock/Serializable/retry protocol, implemented exactly once
 * for every present and future mutating workflow — docs/transaction-design.md
 * §1-2, docs/adr/0003-single-project-lock-mvp.md. Every mutating workflow
 * (finance posting/cancellation today; purchase/inventory/supplier workflows
 * in later phases) calls `runExclusive` and does ALL of its own
 * authorization re-checks, idempotency handling, business validation, and
 * writes inside the supplied callback — the callback re-runs in full, from
 * scratch, on every retry attempt. Nothing outside this class decides
 * whether/how to retry a serialization failure.
 */
@Injectable()
export class ProjectLockService {
  private readonly logger = new Logger(ProjectLockService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Opens a Serializable transaction, acquires `SELECT id FROM "Project"
   * WHERE id = $1 FOR UPDATE` (steps 1-2 of the protocol), then invokes
   * `fn(tx)`. `fn` is responsible for steps 3 onward: re-validating the
   * actor's session/role/project assignment against `tx` (never trusting a
   * pre-transaction check — see `ProjectAccessService.assertAccessInTransaction`),
   * bumping `Project.postingSequence` via `bumpPostingSequence` once
   * authorization passes, and then its own idempotency/business logic.
   *
   * A missing project surfaces as `404 NOT_FOUND` here (existence is the one
   * thing this generic layer checks, since acquiring a lock on a
   * non-existent row is meaningless); active/authorization checks are the
   * caller's job because they depend on the actor and requested action.
   *
   * Retries at most `MAX_ATTEMPTS` times with jittered linear backoff on a
   * genuine serialization failure/deadlock; exhaustion surfaces as
   * `409 CONCURRENT_MODIFICATION` (itself retryable by the client, per
   * docs/backend-architecture.md §9). Any other error propagates
   * immediately, unretried — see `isRetryableError`.
   */
  async runExclusive<T>(
    projectId: string,
    fn: (tx: PrismaTx) => Promise<T>,
  ): Promise<T> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return await this.prisma.client.$transaction(
          async (tx) => {
            const rows = await tx.$queryRaw<{ id: string }[]>`
              SELECT id FROM "Project" WHERE id = ${projectId}::uuid FOR UPDATE
            `;
            if (rows.length === 0) {
              throw new NotFoundException({
                code: 'NOT_FOUND',
                message: 'Project not found',
              });
            }
            return fn(tx);
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (!isRetryableError(error)) {
          throw error;
        }
        if (attempt >= MAX_ATTEMPTS) {
          this.logger.warn(
            `Exhausted ${MAX_ATTEMPTS} attempts locking project ${projectId}; returning 409 CONCURRENT_MODIFICATION`,
          );
          throw new ConflictException({
            code: 'CONCURRENT_MODIFICATION',
            message:
              'This project is being modified concurrently; please retry your request',
          });
        }
        const backoff =
          BASE_BACKOFF_MS * attempt + Math.random() * BASE_BACKOFF_MS;
        this.logger.warn(
          `Serialization conflict on project ${projectId} (attempt ${attempt}/${MAX_ATTEMPTS}); retrying in ${Math.round(backoff)}ms`,
        );
        await sleep(backoff);
      }
    }
  }

  /**
   * Step 4 of the protocol: increments the technical ordering counter and
   * returns its new value, to be stamped onto any `PostedOperation` this
   * attempt goes on to create. Deliberately called only from inside `fn`,
   * after authorization succeeds — never unconditionally by `runExclusive`
   * itself, since incrementing before knowing the caller is even authorized
   * would let an unauthorized request advance a project's sequence.
   */
  async bumpPostingSequence(tx: PrismaTx, projectId: string): Promise<bigint> {
    const updated = await tx.project.update({
      where: { id: projectId },
      data: { postingSequence: { increment: 1 } },
      select: { postingSequence: true },
    });
    return updated.postingSequence;
  }
}
