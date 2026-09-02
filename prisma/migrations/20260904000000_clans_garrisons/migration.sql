-- CreateTable
CREATE TABLE "territory_garrisons" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "territoryId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "marchId" TEXT NOT NULL,
    "clanId" TEXT,
    "units" JSONB NOT NULL,
    "deployedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "territory_garrisons_territoryId_fkey" FOREIGN KEY ("territoryId") REFERENCES "territories" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "territory_garrisons_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "territory_garrisons_marchId_fkey" FOREIGN KEY ("marchId") REFERENCES "marches" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_marches" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playerId" TEXT NOT NULL,
    "targetPlayerId" TEXT,
    "territoryId" TEXT,
    "bossId" TEXT,
    "type" TEXT NOT NULL,
    "units" JSONB NOT NULL,
    "originX" INTEGER NOT NULL,
    "originY" INTEGER NOT NULL,
    "departedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "arrivesAt" DATETIME NOT NULL,
    "returnsAt" DATETIME,
    "survivors" JSONB,
    "outcome" JSONB,
    "status" TEXT NOT NULL DEFAULT 'EN_ROUTE',
    "battleId" TEXT,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "marches_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "marches_targetPlayerId_fkey" FOREIGN KEY ("targetPlayerId") REFERENCES "players" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "marches_territoryId_fkey" FOREIGN KEY ("territoryId") REFERENCES "territories" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "marches_battleId_fkey" FOREIGN KEY ("battleId") REFERENCES "battles" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_marches" ("arrivesAt", "battleId", "bossId", "completedAt", "createdAt", "departedAt", "id", "originX", "originY", "outcome", "playerId", "returnsAt", "status", "survivors", "targetPlayerId", "territoryId", "type", "units", "updatedAt") SELECT "arrivesAt", "battleId", "bossId", "completedAt", "createdAt", "departedAt", "id", "originX", "originY", "outcome", "playerId", "returnsAt", "status", "survivors", "targetPlayerId", "territoryId", "type", "units", "updatedAt" FROM "marches";
DROP TABLE "marches";
ALTER TABLE "new_marches" RENAME TO "marches";
CREATE UNIQUE INDEX "marches_battleId_key" ON "marches"("battleId");
CREATE INDEX "marches_arrivesAt_status_idx" ON "marches"("arrivesAt", "status");
CREATE INDEX "marches_playerId_status_idx" ON "marches"("playerId", "status");
CREATE INDEX "marches_territoryId_idx" ON "marches"("territoryId");
CREATE TABLE "new_territories" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "regionId" TEXT,
    "name" TEXT,
    "terrain" TEXT NOT NULL DEFAULT 'PLAINS',
    "status" TEXT NOT NULL DEFAULT 'UNCLAIMED',
    "ownerType" TEXT NOT NULL DEFAULT 'NONE',
    "ownerPlayerId" TEXT,
    "cityId" TEXT,
    "isCapital" BOOLEAN NOT NULL DEFAULT false,
    "defenseStrength" INTEGER NOT NULL DEFAULT 0,
    "production" JSONB,
    "strategicValue" INTEGER NOT NULL DEFAULT 0,
    "resourceType" TEXT,
    "productionRate" INTEGER NOT NULL DEFAULT 0,
    "productionCollectedAt" DATETIME,
    "captureCount" INTEGER NOT NULL DEFAULT 0,
    "lastCapturedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "territories_ownerPlayerId_fkey" FOREIGN KEY ("ownerPlayerId") REFERENCES "players" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "territories_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "cities" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "territories_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "world_regions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_territories" ("captureCount", "cityId", "createdAt", "defenseStrength", "id", "isCapital", "lastCapturedAt", "name", "ownerPlayerId", "ownerType", "production", "productionCollectedAt", "productionRate", "regionId", "resourceType", "status", "strategicValue", "terrain", "type", "updatedAt", "x", "y") SELECT "captureCount", "cityId", "createdAt", "defenseStrength", "id", "isCapital", "lastCapturedAt", "name", "ownerPlayerId", "ownerType", "production", "productionCollectedAt", "productionRate", "regionId", "resourceType", "status", "strategicValue", "terrain", "type", "updatedAt", "x", "y" FROM "territories";
DROP TABLE "territories";
ALTER TABLE "new_territories" RENAME TO "territories";
CREATE UNIQUE INDEX "territories_cityId_key" ON "territories"("cityId");
CREATE INDEX "territories_ownerPlayerId_idx" ON "territories"("ownerPlayerId");
CREATE INDEX "territories_regionId_idx" ON "territories"("regionId");
CREATE INDEX "territories_status_idx" ON "territories"("status");
CREATE UNIQUE INDEX "territories_x_y_key" ON "territories"("x", "y");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "territory_garrisons_marchId_key" ON "territory_garrisons"("marchId");

-- CreateIndex
CREATE INDEX "territory_garrisons_territoryId_idx" ON "territory_garrisons"("territoryId");

-- CreateIndex
CREATE INDEX "territory_garrisons_playerId_idx" ON "territory_garrisons"("playerId");

