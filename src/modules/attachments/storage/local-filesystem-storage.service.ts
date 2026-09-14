import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { AppConfigService } from '../../../config/app-config.service.js';
import { StorageService, StoredObject } from './storage.interface.js';

/**
 * The dev/test/single-box storage adapter (docs/backend-architecture.md
 * §10). Stores each object as two sibling files under `STORAGE_LOCAL_ROOT`:
 * the raw bytes at `<root>/<key>`, and its content type at
 * `<root>/<key>.contentType` (plain filesystem has no notion of a stored
 * MIME type) — both are re-derived, never trusted, from the caller.
 */
@Injectable()
export class LocalFilesystemStorageService implements StorageService {
  constructor(private readonly config: AppConfigService) {}

  async put(key: string, buffer: Buffer, contentType: string): Promise<void> {
    const path = this.resolveKey(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, buffer);
    await writeFile(`${path}.contentType`, contentType, 'utf8');
  }

  async get(key: string): Promise<StoredObject | null> {
    const path = this.resolveKey(key);
    try {
      const [buffer, contentType] = await Promise.all([
        readFile(path),
        readFile(`${path}.contentType`, 'utf8'),
      ]);
      return { buffer, contentType: contentType.trim() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.resolveKey(key);
    await rm(path, { force: true });
    await rm(`${path}.contentType`, { force: true });
  }

  /**
   * Every `key` this service ever receives is server-generated
   * (`AttachmentsService`'s own opaque `attachments/<uuid>.<ext>` scheme),
   * never client input — but this still defensively re-verifies the
   * resolved path stays under the configured root before touching the
   * filesystem, rather than trusting that invariant silently forever
   * (docs/backend-architecture.md §9's "database constraints are final
   * protection, not service validation alone" principle applied to the
   * filesystem boundary instead).
   */
  private resolveKey(key: string): string {
    const root = resolve(this.config.storageLocalRoot);
    const path = resolve(root, normalize(join('.', key)));
    if (path !== root && !path.startsWith(`${root}/`)) {
      throw new InternalServerErrorException({
        code: 'INTERNAL_ERROR',
        message: 'Resolved storage path escaped the configured root',
      });
    }
    return path;
  }
}
