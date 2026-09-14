import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { BlocksController } from './blocks/blocks.controller.js';
import { BlocksService } from './blocks/blocks.service.js';
import { FloorsController } from './floors/floors.controller.js';
import { FloorsService } from './floors/floors.service.js';

/**
 * One module for both blocks and floors, matching
 * docs/backend-architecture.md's `construction/{blocks,floors}` grouping —
 * they share `BlocksService.getBlockOrThrow` (FloorsService depends on it
 * directly) and are always read/mutated together in practice.
 */
@Module({
  imports: [ProjectsModule],
  controllers: [BlocksController, FloorsController],
  providers: [BlocksService, FloorsService],
})
export class ConstructionModule {}
