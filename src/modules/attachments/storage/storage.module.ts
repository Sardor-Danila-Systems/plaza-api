import { Module } from '@nestjs/common';
import { AppConfigService } from '../../../config/app-config.service.js';
import { LocalFilesystemStorageService } from './local-filesystem-storage.service.js';
import { S3StorageService } from './s3-storage.service.js';
import { STORAGE_SERVICE } from './storage.interface.js';

@Module({
  providers: [
    {
      provide: STORAGE_SERVICE,
      // Constructs ONLY the selected implementation — never both. Listing
      // `S3StorageService` as an ordinary provider here would make Nest
      // eagerly instantiate it at bootstrap regardless of which driver is
      // selected, and its constructor deliberately fails fast without
      // `S3_BUCKET` configured, which would crash every local/dev/test
      // startup that never touches S3 at all.
      useFactory: (config: AppConfigService) =>
        config.storageDriver === 's3'
          ? new S3StorageService(config)
          : new LocalFilesystemStorageService(config),
      inject: [AppConfigService],
    },
  ],
  exports: [STORAGE_SERVICE],
})
export class StorageModule {}
