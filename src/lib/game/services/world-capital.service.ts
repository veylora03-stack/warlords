/**
 * WARLORDS — Capital allocation service (Phase 32: World Map + Territory Engine).
 *
 * A dependency-free leaf: it is imported by the player bootstrap (registration
 * path) AND by the world service, so it may only depend on types, config and
 * the pure generator — never on service modules (import-cycle discipline).
 *
 * Every player receives exactly ONE capital territory at bootstrap:
 *  - anchored 1:1 to the city row (Territory.cityId @unique)
 *  - claimed from the deterministic world grid when the cell exists there
 *    (the generated UNCLAIMED cell is converted), created standalone when the
 *    world has not been generated yet (ensureWorldGenerated backfills region)
 *  - never attackable, never capturable, survives season settlement
 *  - the ownership transition is APPENDED to territory_history (SPAWN)
 */

import type { Tx } from './player-bootstrap.service'
import { AppError } from '@/lib/api/errors'
import { WORLD } from '@/lib/game/config/world'
import { resolveSeasonStateInTx } from './season-state.service'

export interface CapitalClaimResult {
  territoryId: string
  /** True when an existing generated cell was converted into the capital. */
  converted: boolean
}

/**
 * Claims the capital territory for a freshly-created city. MUST run inside
 * the registration transaction (atomic with the player/city creation — a
 * half-claimed capital can never exist). The caller's coordinates come from
 * the city-site search, which already avoids occupied/unclaimable cells.
 */
export async function claimCapitalTerritory(
  tx: Tx,
  input: { playerId: string; cityId: string; x: number; y: number; cityName: string },
): Promise<CapitalClaimResult> {
  const now = new Date()
  const season = await resolveSeasonStateInTx(tx, now)
  const seasonNumber = season?.number ?? 0

  const existing = await tx.territory.findUnique({
    where: { x_y: { x: input.x, y: input.y } },
    select: { id: true, status: true, isCapital: true, ownerPlayerId: true },
  })

  if (existing) {
    // A generated cell can become a capital ONLY while it is unclaimed.
    if (existing.isCapital || existing.ownerPlayerId !== null || existing.status === 'LOCKED') {
      throw new AppError(
        'INTERNAL_ERROR',
        `Capital site (${input.x},${input.y}) is not claimable — city-site search returned an invalid cell`,
      )
    }
    // Conditional conversion — the exactly-once arbiter for the cell.
    const claim = await tx.territory.updateMany({
      where: {
        id: existing.id,
        ownerPlayerId: null,
        isCapital: false,
        status: 'UNCLAIMED',
      },
      data: {
        ownerPlayerId: input.playerId,
        ownerType: 'PLAYER',
        cityId: input.cityId,
        isCapital: true,
        status: 'CONTROLLED',
        type: 'PLAYER_CITY',
        terrain: 'CITY',
        name: input.cityName,
        resourceType: null,
        productionRate: 0,
        productionCollectedAt: null,
        lastCapturedAt: now,
        captureCount: 0,
      },
    })
    if (claim.count !== 1) {
      throw new AppError(
        'INTERNAL_ERROR',
        `Capital claim lost the conditional race at (${input.x},${input.y})`,
      )
    }
    await tx.territoryHistory.create({
      data: {
        territoryId: existing.id,
        seasonNumber,
        previousOwnerType: 'NONE',
        previousOwnerId: null,
        newOwnerType: 'PLAYER',
        newOwnerId: input.playerId,
        battleId: null,
        reason: 'SPAWN',
      },
    })
    return { territoryId: existing.id, converted: true }
  }

  // No generated cell at this coordinate (world not generated yet, or a
  // pre-world legacy city). Create the capital standalone; the region link
  // is backfilled by ensureWorldGenerated when the grid materializes.
  const created = await tx.territory.create({
    data: {
      x: input.x,
      y: input.y,
      type: 'PLAYER_CITY',
      name: input.cityName,
      terrain: 'CITY',
      status: 'CONTROLLED',
      ownerType: 'PLAYER',
      ownerPlayerId: input.playerId,
      cityId: input.cityId,
      isCapital: true,
      lastCapturedAt: now,
    },
    select: { id: true },
  })
  await tx.territoryHistory.create({
    data: {
      territoryId: created.id,
      seasonNumber,
      previousOwnerType: 'NONE',
      previousOwnerId: null,
      newOwnerType: 'PLAYER',
      newOwnerId: input.playerId,
      battleId: null,
      reason: 'SPAWN',
    },
  })
  return { territoryId: created.id, converted: false }
}

/** World-grid bounds helper for the city-site search (avoids a config import there). */
export function worldBounds(): { maxX: number; maxY: number } {
  return { maxX: WORLD.sizeX - 1, maxY: WORLD.sizeY - 1 }
}
