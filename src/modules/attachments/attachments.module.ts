import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { AppConfigService } from '../../config/app-config.service.js';
import { AuditModule } from '../audit/audit.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { AttachmentsCleanupService } from './attachments-cleanup.service.js';
import { AttachmentsController } from './attachments.controller.js';
import { AttachmentsService } from './attachments.service.js';
import { StorageModule } from './storage/storage.module.js';

@Module({
  imports: [
    ProjectsModule,
    AuditModule,
    StorageModule,
    // Async registration so the file-size limit comes from
    // AppConfigService (ATTACHMENT_MAX_SIZE_BYTES) rather than a value
    // frozen at decoration time — `FileInterceptor('file')` in the
    // controller inherits these module-wide options.
    MulterModule.registerAsync({
      useFactory: (config: AppConfigService) => ({
        limits: { fileSize: config.attachmentMaxSizeBytes },
      }),
      inject: [AppConfigService],
    }),
  ],
  controllers: [AttachmentsController],
  providers: [AttachmentsService, AttachmentsCleanupService],
  exports: [AttachmentsCleanupService],
})
export class AttachmentsModule {}
