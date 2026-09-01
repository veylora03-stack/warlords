-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_quests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "objectiveType" TEXT NOT NULL,
    "objectiveTarget" JSONB NOT NULL,
    "reward" JSONB NOT NULL,
    "prerequisiteQuestIds" JSONB,
    "minLevel" INTEGER NOT NULL DEFAULT 0,
    "repeatable" BOOLEAN NOT NULL DEFAULT false,
    "cooldownHours" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_quests" ("cooldownHours", "createdAt", "description", "id", "isActive", "objectiveTarget", "objectiveType", "prerequisiteQuestIds", "repeatable", "reward", "sortOrder", "title", "type", "updatedAt") SELECT "cooldownHours", "createdAt", "description", "id", "isActive", "objectiveTarget", "objectiveType", "prerequisiteQuestIds", "repeatable", "reward", "sortOrder", "title", "type", "updatedAt" FROM "quests";
DROP TABLE "quests";
ALTER TABLE "new_quests" RENAME TO "quests";
CREATE INDEX "quests_type_sortOrder_idx" ON "quests"("type", "sortOrder");
CREATE INDEX "quests_isActive_idx" ON "quests"("isActive");
CREATE TABLE "new_player_quests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playerId" TEXT NOT NULL,
    "questId" TEXT NOT NULL,
    "cycle" TEXT NOT NULL DEFAULT '0',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "target" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "assignedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "completedAt" DATETIME,
    "claimedAt" DATETIME,
    "lastEventKey" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "player_quests_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "player_quests_questId_fkey" FOREIGN KEY ("questId") REFERENCES "quests" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_player_quests" ("assignedAt", "claimedAt", "completedAt", "expiresAt", "id", "playerId", "progress", "questId", "status", "target", "updatedAt") SELECT "assignedAt", "claimedAt", "completedAt", "expiresAt", "id", "playerId", "progress", "questId", "status", "target", "updatedAt" FROM "player_quests";
DROP TABLE "player_quests";
ALTER TABLE "new_player_quests" RENAME TO "player_quests";
CREATE INDEX "player_quests_playerId_status_idx" ON "player_quests"("playerId", "status");
CREATE UNIQUE INDEX "player_quests_playerId_questId_cycle_key" ON "player_quests"("playerId", "questId", "cycle");
CREATE TABLE "new_achievements" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "target" INTEGER NOT NULL DEFAULT 1,
    "metric" TEXT NOT NULL DEFAULT 'STAT',
    "meta" JSONB,
    "reward" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_achievements" ("category", "createdAt", "description", "id", "isActive", "reward", "target", "title", "updatedAt") SELECT "category", "createdAt", "description", "id", "isActive", "reward", "target", "title", "updatedAt" FROM "achievements";
DROP TABLE "achievements";
ALTER TABLE "new_achievements" RENAME TO "achievements";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

