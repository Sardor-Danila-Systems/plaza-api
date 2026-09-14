-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Asia/Samarkand';

-- CreateTable
CREATE TABLE "BuildingBlock" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BuildingBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Floor" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "blockId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Floor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BuildingBlock_projectId_isActive_idx" ON "BuildingBlock"("projectId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "BuildingBlock_projectId_code_key" ON "BuildingBlock"("projectId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "BuildingBlock_projectId_id_key" ON "BuildingBlock"("projectId", "id");

-- CreateIndex
CREATE INDEX "Floor_projectId_blockId_sortOrder_idx" ON "Floor"("projectId", "blockId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Floor_projectId_blockId_label_key" ON "Floor"("projectId", "blockId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "Floor_projectId_blockId_id_key" ON "Floor"("projectId", "blockId", "id");

-- AddForeignKey
ALTER TABLE "BuildingBlock" ADD CONSTRAINT "BuildingBlock_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Floor" ADD CONSTRAINT "Floor_projectId_blockId_fkey" FOREIGN KEY ("projectId", "blockId") REFERENCES "BuildingBlock"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-added: "at most one ACTIVE PROJECT_MANAGER per project." Prisma v7
-- supports partial/filtered unique indexes only behind the `partialIndexes`
-- preview feature (verified against the pinned CLI); this project avoids
-- non-stable Prisma functionality (see docs/adr/0013-project-manager-relation.md),
-- so this is hand-written instead, following the same pattern as
-- docs/adr/0008's CHECK constraints. Deliberately a partial index (WHERE
-- clause), not a plain unique constraint on "projectId": a plain unique
-- constraint would also block a deactivated former manager from keeping
-- their historical projectId once a new manager is assigned to the same
-- project, which would break reassignment's history-preserving design.
CREATE UNIQUE INDEX "User_one_active_manager_per_project"
    ON "User" ("projectId")
    WHERE "role" = 'PROJECT_MANAGER' AND "isActive" = true;
