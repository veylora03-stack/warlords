-- Phase 33 — March & Army Movement Engine (additive only)
-- March extension: server-derived origin, return leg, survivors manifest,
-- outcome summary and terminal timestamp. No new tables; no index changes
-- (per-player lazy processing reads by the existing (playerId, status) and
-- (arrivesAt, status) indexes; no global sweep exists).

-- AlterTable
ALTER TABLE "marches" ADD COLUMN     "originX" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "originY" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "returnsAt" TIMESTAMP(3),
ADD COLUMN     "survivors" JSONB,
ADD COLUMN     "outcome" JSONB,
ADD COLUMN     "completedAt" TIMESTAMP(3);
