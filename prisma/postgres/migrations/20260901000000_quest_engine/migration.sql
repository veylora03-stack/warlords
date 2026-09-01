-- AlterTable
ALTER TABLE "quests" ADD COLUMN     "minLevel" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "player_quests" ADD COLUMN     "cycle" TEXT NOT NULL DEFAULT '0',
ADD COLUMN     "lastEventKey" TEXT;

-- AlterTable
ALTER TABLE "achievements" ADD COLUMN     "meta" JSONB,
ADD COLUMN     "metric" TEXT NOT NULL DEFAULT 'STAT';

-- CreateIndex
CREATE INDEX "quests_isActive_idx" ON "quests"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "player_quests_playerId_questId_cycle_key" ON "player_quests"("playerId", "questId", "cycle");

