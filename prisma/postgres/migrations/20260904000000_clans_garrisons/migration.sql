-- Phase 34 — Clans & Positional Territory Garrisons (additive only)
-- New table: territory_garrisons — one row per deployed march contribution
-- (TerritoryGarrison model). The march row carries the lifecycle state machine
-- (EN_ROUTE → ARRIVED → RETURNING/LOST), so the garrison table persists no
-- transient states. PostgreSQL twin of the SQLite migration.

-- CreateTable
CREATE TABLE "territory_garrisons" (
    "id" TEXT NOT NULL,
    "territoryId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "marchId" TEXT NOT NULL,
    "clanId" TEXT,
    "units" JSONB NOT NULL,
    "deployedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "territory_garrisons_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "territory_garrisons_marchId_key" ON "territory_garrisons"("marchId");

-- CreateIndex
CREATE INDEX "territory_garrisons_territoryId_idx" ON "territory_garrisons"("territoryId");

-- CreateIndex
CREATE INDEX "territory_garrisons_playerId_idx" ON "territory_garrisons"("playerId");

-- AddForeignKey
ALTER TABLE "territory_garrisons" ADD CONSTRAINT "territory_garrisons_territoryId_fkey" FOREIGN KEY ("territoryId") REFERENCES "territories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "territory_garrisons" ADD CONSTRAINT "territory_garrisons_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "territory_garrisons" ADD CONSTRAINT "territory_garrisons_marchId_fkey" FOREIGN KEY ("marchId") REFERENCES "marches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
