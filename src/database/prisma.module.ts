import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { ProjectLockService } from './project-lock.service.js';

@Global()
@Module({
  providers: [PrismaService, ProjectLockService],
  exports: [PrismaService, ProjectLockService],
})
export class PrismaModule {}
