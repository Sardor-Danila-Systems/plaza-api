import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { AuditController } from './audit.controller.js';
import { AuditQueryService } from './audit-query.service.js';
import { AuditService } from './audit.service.js';

@Module({
  imports: [ProjectsModule],
  controllers: [AuditController],
  providers: [AuditService, AuditQueryService],
  exports: [AuditService],
})
export class AuditModule {}
