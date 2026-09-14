import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { AppConfigService } from '../../../config/app-config.service.js';
import { StorageService, StoredObject } from './storage.interface.js';

/**
 * The production storage adapter (docs/backend-architecture.md §10): any
 * S3-compatible endpoint — real AWS S3, MinIO, or Supabase Storage (which
 * documents an S3-compatible API) — selected via `S3_ENDPOINT`/
 * `S3_FORCE_PATH_STYLE`. Never issues a public/anonymous URL; every read
 * goes through this SDK client using the configured credentials, and
 * `AttachmentsService`'s own download endpoint is the only thing that ever
 * calls `get` — see that service's doc comment for why this project
 * proxies bytes through an authorized endpoint rather than handing out a
 * signed URL.
 */
@Injectable()
export class S3StorageService implements StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: AppConfigService) {
    if (!config.s3Bucket) {
      throw new InternalServerErrorException({
        code: 'INTERNAL_ERROR',
        message: 'S3_BUCKET is required when STORAGE_DRIVER=s3',
      });
    }
    this.bucket = config.s3Bucket;
    this.client = new S3Client({
      region: config.s3Region ?? 'us-east-1',
      endpoint: config.s3Endpoint,
      forcePathStyle: config.s3ForcePathStyle,
      credentials:
        config.s3AccessKeyId && config.s3SecretAccessKey
          ? {
              accessKeyId: config.s3AccessKeyId,
              secretAccessKey: config.s3SecretAccessKey,
            }
          : undefined,
    });
  }

  async put(key: string, buffer: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const buffer = Buffer.from(await result.Body!.transformToByteArray());
      return {
        buffer,
        contentType: result.ContentType ?? 'application/octet-stream',
      };
    } catch (error) {
      if (error instanceof NoSuchKey || error instanceof NotFound) {
        return null;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
