/*
  Warnings:

  - Added the required column `trainingBuilding` to the `units` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_units" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "class" TEXT NOT NULL,
    "tier" INTEGER NOT NULL DEFAULT 1,
    "attack" INTEGER NOT NULL,
    "defense" INTEGER NOT NULL,
    "health" INTEGER NOT NULL,
    "speed" INTEGER NOT NULL,
    "foodUpkeep" INTEGER NOT NULL,
    "carryCapacity" INTEGER NOT NULL DEFAULT 0,
    "trainingCost" JSONB NOT NULL,
    "trainingTimeSec" INTEGER NOT NULL,
    "trainingBuilding" TEXT NOT NULL,
    "requiredBuildingLevel" INTEGER NOT NULL DEFAULT 1,
    "strongAgainst" JSONB,
    "weakAgainst" JSONB,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_units" ("attack", "carryCapacity", "class", "createdAt", "defense", "description", "foodUpkeep", "health", "id", "isActive", "name", "speed", "strongAgainst", "tier", "trainingCost", "trainingTimeSec", "trainingBuilding", "requiredBuildingLevel", "updatedAt", "weakAgainst") SELECT "attack", "carryCapacity", "class", "createdAt", "defense", "description", "foodUpkeep", "health", "id", "isActive", "name", "speed", "strongAgainst", "tier", "trainingCost", "trainingTimeSec",
  -- Backfill the training-building mapping for pre-Phase-7 roster rows;
  -- the seed pipeline immediately overwrites these with the authoritative
  -- catalog values (and soft-retires units that left the roster).
  CASE "id"
    WHEN 'archer' THEN 'ARCHER_CAMP'
    WHEN 'catapult' THEN 'ARMORY'
    ELSE 'BARRACKS'
  END,
  1,
  "updatedAt", "weakAgainst" FROM "units";
DROP TABLE "units";
ALTER TABLE "new_units" RENAME TO "units";
CREATE INDEX "units_class_tier_idx" ON "units"("class", "tier");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "training_queue_items_playerId_status_idx" ON "training_queue_items"("playerId", "status");
