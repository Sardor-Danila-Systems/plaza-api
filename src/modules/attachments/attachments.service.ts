import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service.js';
import { PrismaTx } from '../../database/project-lock.service.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  Attachment,
  AttachmentStatus,
  FinancialTransactionType,
  Prisma,
} from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { ProjectAccessAction } from '../projects/project-access-action.enum.js';
import { ProjectAccessService } from '../projects/project-access.service.js';
import {
  UnsupportedFileTypeError,
  detectAndValidateMimeType,
  extensionForMimeType,
  sanitizeOriginalFilename,
} from './attachment-validation.util.js';
import { AttachmentTarget } from './attachment-target.enum.js';
import { AttachmentResponseDto } from './dto/attachment-response.dto.js';
import { LinkAttachmentDto } from './dto/link-attachment.dto.js';
import { ListAttachmentsQueryDto } from './dto/list-attachments-query.dto.js';
import { PaginatedAttachmentsResponseDto } from './dto/paginated-attachments-response.dto.js';
import { STORAGE_SERVICE } from './storage/storage.interface.js';
import type { StorageService } from './storage/storage.interface.js';

export interface DownloadedAttachment {
  buffer: Buffer;
  contentType: string;
  filename: string;
}

/**
 * Staged uploads (docs/backend-architecture.md §10): `upload` takes the
 * file straight through to `READY` or `FAILED` within one request (this
 * MVP has no separate "begin upload" HTTP step — see the `Attachment`
 * model's own doc comment), and `link` is the short, separately-authorized
 * database transaction that turns a verified `READY` object into a
 * `LINKED` one. The two are DELIBERATELY separate calls: "business posting
 * need not wait for uploads; a failed upload must not fabricate a
 * successful attachment or roll back an already committed purchase."
 *
 * Storage and PostgreSQL never share a transaction here: `upload` inserts
 * `PENDING` (plain insert), calls `storage.put` OUTSIDE any transaction,
 * then updates to `READY`/`FAILED` (another plain update) — never the
 * project-lock/Serializable protocol, which is reserved for the accounting
 * workflows that actually need it (this never touches money or inventory).
 */
@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  async upload(
    user: AuthenticatedUser,
    projectId: string,
    file: Express.Multer.File,
    requestId?: string,
  ): Promise<AttachmentResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.WRITE,
    );

    if (file.size > this.config.attachmentMaxSizeBytes) {
      throw new ConflictException({
        code: 'FILE_TOO_LARGE',
        message: `File exceeds the maximum allowed size of ${this.config.attachmentMaxSizeBytes} bytes`,
      });
    }

    let mimeType: string;
    try {
      mimeType = await detectAndValidateMimeType(file.buffer);
    } catch (error) {
      if (error instanceof UnsupportedFileTypeError) {
        throw new ConflictException({
          code: 'UNSUPPORTED_FILE_TYPE',
          message:
            'Only JPEG, PNG, WebP, and PDF files are accepted, verified by content, not by extension',
        });
      }
      throw error;
    }

    const originalFilename = sanitizeOriginalFilename(file.originalname);
    const storageKey = `attachments/${projectId}/${randomUUID()}.${extensionForMimeType(mimeType)}`;
    const expiresAt = new Date(Date.now() + this.config.attachmentOrphanTtlMs);

    const pending = await this.prisma.client.attachment.create({
      data: {
        projectId,
        status: AttachmentStatus.PENDING,
        storageKey,
        originalFilename,
        mimeType,
        sizeBytes: file.size,
        uploadedById: user.id,
        expiresAt,
      },
    });

    try {
      await this.storage.put(storageKey, file.buffer, mimeType);
    } catch (error) {
      const failed = await this.prisma.client.attachment.update({
        where: { id: pending.id },
        data: {
          status: AttachmentStatus.FAILED,
          failedAt: new Date(),
          failureReason:
            error instanceof Error ? error.message : 'Upload failed',
        },
      });
      // A failed upload never fabricates a successful attachment
      // (docs/backend-architecture.md §10) — surfaced as a clean conflict,
      // not a raw storage error.
      throw new ConflictException({
        code: 'ATTACHMENT_UPLOAD_FAILED',
        message: 'The file could not be stored',
        attachmentId: failed.id,
      });
    }

    const ready = await this.prisma.client.$transaction(async (tx) => {
      const row = await tx.attachment.update({
        where: { id: pending.id },
        data: { status: AttachmentStatus.READY, readyAt: new Date() },
      });
      await this.audit.record(tx, {
        projectId,
        actorId: user.id,
        action: 'attachment.upload',
        entityType: 'Attachment',
        entityId: row.id,
        requestId,
        newData: { ...this.toResponse(row) },
      });
      return row;
    });

    return this.toResponse(ready);
  }

  async link(
    user: AuthenticatedUser,
    projectId: string,
    attachmentId: string,
    dto: LinkAttachmentDto,
    requestId?: string,
  ): Promise<AttachmentResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.WRITE,
    );

    const attachment = await this.getOwnAttachmentOrThrow(
      projectId,
      attachmentId,
    );
    if (attachment.status !== AttachmentStatus.READY) {
      throw new ConflictException({
        code: 'ATTACHMENT_NOT_READY',
        message: `Attachment is ${attachment.status}, not READY`,
      });
    }

    const linked = await this.prisma.client.$transaction(async (tx) => {
      const targetFields = await this.resolveTarget(
        tx,
        projectId,
        dto.target,
        dto.targetId,
      );
      const row = await tx.attachment.update({
        where: { id: attachment.id },
        data: {
          status: AttachmentStatus.LINKED,
          linkedAt: new Date(),
          expiresAt: null,
          ...targetFields,
        },
      });
      await this.audit.record(tx, {
        projectId,
        actorId: user.id,
        action: 'attachment.link',
        entityType: 'Attachment',
        entityId: row.id,
        requestId,
        previousData: { ...this.toResponse(attachment) },
        newData: { ...this.toResponse(row) },
      });
      return row;
    });

    return this.toResponse(linked);
  }

  async list(
    user: AuthenticatedUser,
    projectId: string,
    query: ListAttachmentsQueryDto,
  ): Promise<PaginatedAttachmentsResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );

    if (
      (query.target && !query.targetId) ||
      (!query.target && query.targetId)
    ) {
      throw new ConflictException({
        code: 'VALIDATION_ERROR',
        message: 'target and targetId must be supplied together',
      });
    }

    const where: Prisma.AttachmentWhereInput = { projectId };
    if (query.target && query.targetId) {
      Object.assign(where, {
        status: AttachmentStatus.LINKED,
        ...this.targetWhere(query.target, query.targetId),
      });
    }

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [rows, total] = await Promise.all([
      this.prisma.client.attachment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.client.attachment.count({ where }),
    ]);

    return {
      data: rows.map((row) => this.toResponse(row)),
      total,
      page,
      pageSize,
    };
  }

  async get(
    user: AuthenticatedUser,
    projectId: string,
    attachmentId: string,
  ): Promise<AttachmentResponseDto> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    return this.toResponse(
      await this.getOwnAttachmentOrThrow(projectId, attachmentId),
    );
  }

  /**
   * Streams the verified bytes back through this authorized endpoint —
   * never a raw storage URL or signed link handed to the client
   * (docs/backend-architecture.md §10: "report/file access must not become
   * public through an object key"; this project's own choice among the
   * doc's two allowed shapes, "an authorized stream or a short-lived
   * signed URL").
   */
  async download(
    user: AuthenticatedUser,
    projectId: string,
    attachmentId: string,
  ): Promise<DownloadedAttachment> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.READ,
    );
    const attachment = await this.getOwnAttachmentOrThrow(
      projectId,
      attachmentId,
    );
    if (
      attachment.status !== AttachmentStatus.READY &&
      attachment.status !== AttachmentStatus.LINKED
    ) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'This attachment has no retrievable file',
      });
    }

    const stored = await this.storage.get(attachment.storageKey);
    if (!stored) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'The stored file could not be found',
      });
    }

    return {
      buffer: stored.buffer,
      contentType: attachment.mimeType,
      filename: attachment.originalFilename,
    };
  }

  /**
   * Conservative by design (this phase's §9.9): only ever removes an
   * attachment that was NEVER linked to a business record — a `LINKED` row
   * is retained forever with the record it documents. This check is
   * enforced here, in application code, the same way Purchase/StockMovement/
   * SettlementAllocation's own historical rows are protected: by there being
   * no other code path that can delete one, not by a database trigger
   * blocking every delete unconditionally (which would also block the
   * dependency-ordered raw deletes test fixtures and admin tooling
   * legitimately need — see the migration that removed that trigger).
   */
  async deleteOrphan(
    user: AuthenticatedUser,
    projectId: string,
    attachmentId: string,
    requestId?: string,
  ): Promise<void> {
    await this.projectAccess.assertAccess(
      user,
      projectId,
      ProjectAccessAction.WRITE,
    );
    const attachment = await this.getOwnAttachmentOrThrow(
      projectId,
      attachmentId,
    );
    if (attachment.status === AttachmentStatus.LINKED) {
      throw new ConflictException({
        code: 'ATTACHMENT_LINKED',
        message: 'A linked attachment cannot be deleted',
      });
    }

    await this.storage.delete(attachment.storageKey);
    await this.prisma.client.$transaction(async (tx) => {
      await tx.attachment.delete({ where: { id: attachment.id } });
      await this.audit.record(tx, {
        projectId,
        actorId: user.id,
        action: 'attachment.delete',
        entityType: 'Attachment',
        entityId: attachment.id,
        requestId,
        previousData: { ...this.toResponse(attachment) },
        newData: {},
      });
    });
  }

  // ---------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------

  private async getOwnAttachmentOrThrow(
    projectId: string,
    attachmentId: string,
  ): Promise<Attachment> {
    const attachment = await this.prisma.client.attachment.findFirst({
      where: { id: attachmentId, projectId },
    });
    if (!attachment) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Attachment not found in this project',
      });
    }
    return attachment;
  }

  private targetWhere(
    target: AttachmentTarget,
    targetId: string,
  ): Record<string, string> {
    switch (target) {
      case AttachmentTarget.PURCHASE:
        return { purchaseId: targetId };
      case AttachmentTarget.FINANCIAL_TRANSACTION:
        return { financialTransactionId: targetId };
      case AttachmentTarget.SUPPLIER_PAYMENT:
        return { supplierPaymentId: targetId };
    }
  }

  private async resolveTarget(
    tx: PrismaTx,
    projectId: string,
    target: AttachmentTarget,
    targetId: string,
  ): Promise<Record<string, string>> {
    switch (target) {
      case AttachmentTarget.PURCHASE: {
        const purchase = await tx.purchase.findFirst({
          where: { id: targetId, projectId },
        });
        if (!purchase) {
          throw new NotFoundException({
            code: 'NOT_FOUND',
            message: 'Purchase not found in this project',
          });
        }
        return { purchaseId: targetId };
      }
      case AttachmentTarget.FINANCIAL_TRANSACTION: {
        const transaction = await tx.financialTransaction.findFirst({
          where: { id: targetId, projectId },
        });
        if (!transaction) {
          throw new NotFoundException({
            code: 'NOT_FOUND',
            message: 'Financial transaction not found in this project',
          });
        }
        if (
          transaction.type !== FinancialTransactionType.INCOME &&
          transaction.type !== FinancialTransactionType.EXPENSE
        ) {
          throw new ConflictException({
            code: 'UNSUPPORTED_ATTACHMENT_TARGET',
            message:
              'Attachments may only target INCOME or EXPENSE financial transactions directly',
          });
        }
        return { financialTransactionId: targetId };
      }
      case AttachmentTarget.SUPPLIER_PAYMENT: {
        const payment = await tx.supplierPayment.findFirst({
          where: { id: targetId, projectId },
        });
        if (!payment) {
          throw new NotFoundException({
            code: 'NOT_FOUND',
            message: 'Supplier payment not found in this project',
          });
        }
        return { supplierPaymentId: targetId };
      }
    }
  }

  private toResponse(attachment: Attachment): AttachmentResponseDto {
    let target: AttachmentTarget | null = null;
    let targetId: string | null = null;
    if (attachment.purchaseId) {
      target = AttachmentTarget.PURCHASE;
      targetId = attachment.purchaseId;
    } else if (attachment.financialTransactionId) {
      target = AttachmentTarget.FINANCIAL_TRANSACTION;
      targetId = attachment.financialTransactionId;
    } else if (attachment.supplierPaymentId) {
      target = AttachmentTarget.SUPPLIER_PAYMENT;
      targetId = attachment.supplierPaymentId;
    }

    return {
      id: attachment.id,
      projectId: attachment.projectId,
      status: attachment.status,
      originalFilename: attachment.originalFilename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      uploadedById: attachment.uploadedById,
      createdAt: attachment.createdAt,
      readyAt: attachment.readyAt,
      linkedAt: attachment.linkedAt,
      failedAt: attachment.failedAt,
      failureReason: attachment.failureReason,
      target,
      targetId,
    };
  }
}
