import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { AttachmentStatus } from '../../generated/prisma/client.js';
import { STORAGE_SERVICE } from './storage/storage.interface.js';
import type { StorageService } from './storage/storage.interface.js';

/**
 * The orphan cleanup job docs/backend-architecture.md §10 asks for: "Use
 * staged uploads with PENDING -> READY -> LINKED or FAILED, expiry, and an
 * orphan cleanup job." Deletes the storage object first, then the DB row —
 * a crash between the two leaves a harmless dangling row (caught by the
 * NEXT run, `storage.delete` on an already-missing key is a no-op for both
 * adapters) rather than a DB row pointing at content that no longer exists.
 *
 * Not wired to a live scheduler in this codebase (no scheduling
 * infrastructure exists anywhere else in it yet — see this phase's own
 * report for why adding one wasn't justified for a single job): call
 * `cleanupExpired()` from a deployment-level cron/scheduled task hitting a
 * small authenticated admin trigger, or via `@nestjs/schedule` if/when this
 * application adopts a scheduler for other reasons too.
 */
@Injectable()
export class AttachmentsCleanupService {
  private readonly logger = new Logger(AttachmentsCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  /** Returns the number of expired, never-linked attachments removed. */
  async cleanupExpired(now: Date = new Date()): Promise<number> {
    const expired = await this.prisma.client.attachment.findMany({
      where: {
        status: {
          in: [
            AttachmentStatus.PENDING,
            AttachmentStatus.READY,
            AttachmentStatus.FAILED,
          ],
        },
        expiresAt: { lt: now },
      },
    });

    let removed = 0;
    for (const attachment of expired) {
      try {
        await this.storage.delete(attachment.storageKey);
        // A LINKED row can never match the `status` filter above, but this
        // re-reads and re-checks per-row rather than trusting the initial
        // snapshot, in case a concurrent request linked it in the gap
        // between the query above and this delete.
        await this.prisma.client.attachment.deleteMany({
          where: {
            id: attachment.id,
            status: { not: AttachmentStatus.LINKED },
          },
        });
        removed += 1;
      } catch (error) {
        this.logger.warn(
          `Failed to clean up expired attachment ${attachment.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return removed;
  }
}
