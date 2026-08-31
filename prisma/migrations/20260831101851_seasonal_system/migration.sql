-- AlterTable
ALTER TABLE "seasons" ADD COLUMN "settledAt" DATETIME;

-- CreateTable
CREATE TABLE "season_reward_claims" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "seasonId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "tierName" TEXT NOT NULL,
    "rewards" JSONB NOT NULL,
    "claimedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "season_reward_claims_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "seasons" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "season_reward_claims_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "season_wallets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "seasonId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "shards" BIGINT NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "season_wallets_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "seasons" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "season_wallets_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "cosmetics" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "rarity" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "player_cosmetics" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playerId" TEXT NOT NULL,
    "cosmeticId" TEXT NOT NULL,
    "acquiredSeason" INTEGER,
    "unlockedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "player_cosmetics_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "player_cosmetics_cosmeticId_fkey" FOREIGN KEY ("cosmeticId") REFERENCES "cosmetics" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "titles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "rarity" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "player_titles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playerId" TEXT NOT NULL,
    "titleId" TEXT NOT NULL,
    "acquiredSeason" INTEGER,
    "unlockedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "player_titles_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "player_titles_titleId_fkey" FOREIGN KEY ("titleId") REFERENCES "titles" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_commanders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "rarity" TEXT NOT NULL,
    "baseStats" JSONB NOT NULL,
    "skills" JSONB NOT NULL,
    "passive" JSONB NOT NULL,
    "lore" TEXT,
    "isSeasonal" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_commanders" ("baseStats", "createdAt", "id", "isActive", "lore", "name", "passive", "rarity", "skills", "updatedAt") SELECT "baseStats", "createdAt", "id", "isActive", "lore", "name", "passive", "rarity", "skills", "updatedAt" FROM "commanders";
DROP TABLE "commanders";
ALTER TABLE "new_commanders" RENAME TO "commanders";
CREATE TABLE "new_players" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "level" INTEGER NOT NULL DEFAULT 1,
    "xp" BIGINT NOT NULL DEFAULT 0,
    "power" BIGINT NOT NULL DEFAULT 0,
    "honor" BIGINT NOT NULL DEFAULT 0,
    "reputation" TEXT NOT NULL DEFAULT 'NEUTRAL',
    "reputationScore" INTEGER NOT NULL DEFAULT 0,
    "gems" BIGINT NOT NULL DEFAULT 0,
    "energy" INTEGER NOT NULL DEFAULT 100,
    "energyUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seasonPoints" INTEGER NOT NULL DEFAULT 0,
    "activeTitleId" TEXT,
    "stats" JSONB,
    "clanId" TEXT,
    "clanRole" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "players_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "players_clanId_fkey" FOREIGN KEY ("clanId") REFERENCES "clans" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "players_activeTitleId_fkey" FOREIGN KEY ("activeTitleId") REFERENCES "titles" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_players" ("avatarUrl", "clanId", "clanRole", "createdAt", "energy", "energyUpdatedAt", "gems", "honor", "id", "level", "name", "power", "reputation", "reputationScore", "seasonPoints", "stats", "updatedAt", "userId", "xp") SELECT "avatarUrl", "clanId", "clanRole", "createdAt", "energy", "energyUpdatedAt", "gems", "honor", "id", "level", "name", "power", "reputation", "reputationScore", "seasonPoints", "stats", "updatedAt", "userId", "xp" FROM "players";
DROP TABLE "players";
ALTER TABLE "new_players" RENAME TO "players";
CREATE UNIQUE INDEX "players_userId_key" ON "players"("userId");
CREATE INDEX "players_power_idx" ON "players"("power");
CREATE INDEX "players_honor_idx" ON "players"("honor");
CREATE INDEX "players_clanId_idx" ON "players"("clanId");
CREATE INDEX "players_seasonPoints_idx" ON "players"("seasonPoints");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "season_reward_claims_playerId_claimedAt_idx" ON "season_reward_claims"("playerId", "claimedAt");

-- CreateIndex
CREATE UNIQUE INDEX "season_reward_claims_seasonId_playerId_key" ON "season_reward_claims"("seasonId", "playerId");

-- CreateIndex
CREATE UNIQUE INDEX "season_wallets_seasonId_playerId_key" ON "season_wallets"("seasonId", "playerId");

-- CreateIndex
CREATE INDEX "player_cosmetics_playerId_unlockedAt_idx" ON "player_cosmetics"("playerId", "unlockedAt");

-- CreateIndex
CREATE UNIQUE INDEX "player_cosmetics_playerId_cosmeticId_key" ON "player_cosmetics"("playerId", "cosmeticId");

-- CreateIndex
CREATE INDEX "player_titles_playerId_unlockedAt_idx" ON "player_titles"("playerId", "unlockedAt");

-- CreateIndex
CREATE UNIQUE INDEX "player_titles_playerId_titleId_key" ON "player_titles"("playerId", "titleId");
