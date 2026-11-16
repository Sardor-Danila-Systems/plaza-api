-- Construction stage (очередь) and build order for building blocks.
ALTER TABLE "BuildingBlock" ADD COLUMN "stage" TEXT;
ALTER TABLE "BuildingBlock" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;
