import { Module } from '@nestjs/common';
import { ProjectAccessService } from './project-access.service.js';
import { ProjectProvisioningService } from './project-provisioning.service.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';

@Module({
  controllers: [ProjectsController],
  providers: [
    ProjectAccessService,
    ProjectsService,
    ProjectProvisioningService,
  ],
  // ProjectAccessService: Phase 4+ controllers in other modules call it
  // before touching project-scoped data. ProjectProvisioningService: only
  // src/cli/provision.ts and prisma/seed.ts call it (never a controller —
  // see ADR 0014).
  exports: [ProjectAccessService, ProjectProvisioningService],
})
export class ProjectsModule {}
