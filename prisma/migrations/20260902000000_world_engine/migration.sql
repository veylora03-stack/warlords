-- Phase 32 — World Map + Territory Engine (additive only)
-- Territory extension + persistent regions + append-only territory history.

-- AlterTable
ALTER TABLE "territories" ADD COLUMN "regionId" TEXT;
ALTER TABLE "territories" ADD COLUMN "name" TEXT;
ALTER TABLE "territories" ADD COLUMN "terrain" TEXT NOT NULL DEFAULT 'PLAINS';
ALTER TABLE "territories" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'UNCLAIMED';
ALTER TABLE "territories" ADD COLUMN "ownerType" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "territories" ADD COLUMN "isCapital" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "territories" ADD COLUMN "resourceType" TEXT;
ALTER TABLE "territories" ADD COLUMN "productionRate" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "territories" ADD COLUMN "productionCollectedAt" DATETIME;
ALTER TABLE "territories" ADD COLUMN "captureCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "world_regions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "minX" INTEGER NOT NULL,
    "maxX" INTEGER NOT NULL,
    "minY" INTEGER NOT NULL,
    "maxY" INTEGER NOT NULL,
    "metadata" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "territory_history" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "territoryId" TEXT NOT NULL,
    "seasonNumber" INTEGER NOT NULL,
    "previousOwnerType" TEXT NOT NULL DEFAULT 'NONE',
    "previousOwnerId" TEXT,
    "newOwnerType" TEXT NOT NULL DEFAULT 'NONE',
    "newOwnerId" TEXT,
    "battleId" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "territory_history_territoryId_fkey" FOREIGN KEY ("territoryId") REFERENCES "territories" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "world_regions_minX_minY_key" ON "world_regions"("minX", "minY");
CREATE INDEX "world_regions_isActive_idx" ON "world_regions"("isActive");
CREATE INDEX "territory_history_territoryId_createdAt_idx" ON "territory_history"("territoryId", "createdAt");
CREATE INDEX "territory_history_seasonNumber_idx" ON "territory_history"("seasonNumber");
CREATE INDEX "territories_regionId_idx" ON "territories"("regionId");
CREATE INDEX "territories_status_idx" ON "territories"("status");
