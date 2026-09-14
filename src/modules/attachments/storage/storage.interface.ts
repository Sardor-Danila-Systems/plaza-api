/**
 * The small storage interface docs/backend-architecture.md §10 asks for:
 * "a real local-filesystem development adapter and a real S3-compatible
 * deployment adapter behind the small storage interface." Every method is
 * keyed by the SAME opaque, server-generated `key` — never a client-supplied
 * path, never derived from the original filename (§10: "no client-supplied
 * filesystem paths or remote URL fetching"). Callers never call this from
 * inside a Prisma transaction (§10: "Storage and PostgreSQL cannot share a
 * transaction") — see `AttachmentsService.upload`'s own doc comment for the
 * exact sequencing this implies.
 */
export interface StoredObject {
  buffer: Buffer;
  contentType: string;
}

export const STORAGE_SERVICE = Symbol('STORAGE_SERVICE');

export interface StorageService {
  put(key: string, buffer: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}
