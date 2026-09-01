-- Phase 32 — World Map + Territory Engine (additive only)
-- Territory extension + persistent regions + append-only territory history.

-- AlterTable
ALTER TABLE "territories" ADD COLUMN     "regionId" TEXT,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "terrain" TEXT NOT NULL DEFAULT 'PLAINS',
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'UNCLAIMED',
ADD COLUMN     "ownerType" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "isCapital" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "resourceType" TEXT,
ADD COLUMN     "productionRate" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "productionCollectedAt" TIMESTAMP(3),
ADD COLUMN     "captureCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "world_regions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minX" INTEGER NOT NULL,
    "maxX" INTEGER NOT NULL,
    "minY" INTEGER NOT NULL,
    "maxY" INTEGER NOT NULL,
    "metadata" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "world_regions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "territory_history" (
    "id" TEXT NOT NULL,
    "territoryId" TEXT NOT NULL,
    "seasonNumber" INTEGER NOT NULL,
    "previousOwnerType" TEXT NOT NULL DEFAULT 'NONE',
    "previousOwnerId" TEXT,
    "newOwnerType" TEXT NOT NULL DEFAULT 'NONE',
    "newOwnerId" TEXT,
    "battleId" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "territory_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "world_regions_minX_minY_key" ON "world_regions"("minX", "minY");
CREATE INDEX "world_regions_isActive_idx" ON "world_regions"("isActive");
CREATE INDEX "territory_history_territoryId_createdAt_idx" ON "territory_history"("territoryId", "createdAt");
CREATE INDEX "territory_history_seasonNumber_idx" ON "territory_history"("seasonNumber");
CREATE INDEX "territories_regionId_idx" ON "territories"("regionId");
CREATE INDEX "territories_status_idx" ON "territories"("status");

-- AddForeignKey
ALTER TABLE "territories" ADD CONSTRAINT "territories_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "world_regions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "territory_history" ADD CONSTRAINT "territory_history_territoryId_fkey" FOREIGN KEY ("territoryId") REFERENCES "territories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
