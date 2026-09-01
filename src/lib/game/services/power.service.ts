/**
 * WARLORDS — Power service.
 *
 * Power is a DERIVED metric: it is always recomputed from the player's real
 * state (army stacks × catalog stats, buildings × levels, researched
 * technologies × levels) using the data-driven weights in config/power.ts.
 *
 * Security contract (Phase 4 requirement): power can NEVER be set, pushed,
 * or adjusted by a client — there is no write path except
 * `recalculatePlayerPower`, which reads only server-owned tables. A tampered
 * `Player.power` column heals itself on the next recalculation, and both
 * profile/state endpoints return the FRESHLY computed value.
 *
 * Catalogs are read from the DB (the seeded mirror of config), never from
 * the config folder directly — balance changes deploy via the seed pipeline.
 */

import type { Tx } from './player-bootstrap.service'
import { applyQuestEventInTx } from './quest-events.service'
import type { PowerBreakdown } from '@/lib/game/config/power'
import {
  computeBuildingPower,
  computeTechPower,
  computeUnitStackPower,
} from '@/lib/game/config/power'

/**
 * Pure aggregation over ALREADY-LOADED rows (Phase 25): lets the state
 * projection compute power from the same parallel read round it uses for
 * army/city data instead of issuing three more queries.
 */
export function computePowerFromRows(
  stacks: Array<{
    count: number
    unit: { attack: number; defense: number; health: number; tier: number }
  }>,
  buildings: Array<{ type: string; level: number }>,
  techs: Array<{ level: number; technology: { branch: string } }>,
): PowerBreakdown {
  let units = 0
  for (const stack of stacks) {
    units += computeUnitStackPower(stack.unit, stack.count)
  }

  let buildingPower = 0
  for (const building of buildings) {
    buildingPower += computeBuildingPower(building.type, building.level)
  }

  let technologies = 0
  for (const tech of techs) {
    technologies += computeTechPower(tech.technology.branch, tech.level)
  }

  return {
    units,
    buildings: buildingPower,
    technologies,
    total: units + buildingPower + technologies,
  }
}

/** Aggregates every power source for a player from server-owned state. */
export async function computePlayerPower(tx: Tx, playerId: string): Promise<PowerBreakdown> {
  // Army: stacks joined with the unit catalog (attack/defense/health/tier).
  const stacks = await tx.playerUnit.findMany({
    where: { playerId },
    select: {
      count: true,
      unit: { select: { attack: true, defense: true, health: true, tier: true } },
    },
  })

  // Buildings: every building across all of the player's cities.
  const buildings = await tx.building.findMany({
    where: { city: { playerId } },
    select: { type: true, level: true },
  })

  // Technologies: researched levels joined with the branch catalog.
  const techs = await tx.playerTechnology.findMany({
    where: { playerId },
    select: { level: true, technology: { select: { branch: true } } },
  })

  return computePowerFromRows(stacks, buildings, techs)
}

/**
 * Recomputes power from real state and persists it onto Player.power.
 * Call INSIDE a transaction that just mutated army/buildings/technologies —
 * this is the only legitimate write path for the column.
 */
export async function recalculatePlayerPower(tx: Tx, playerId: string): Promise<number> {
  const power = await computePlayerPower(tx, playerId)
  await tx.player.update({
    where: { id: playerId },
    data: { power: BigInt(power.total) },
  })
  // Quest event (Phase 31): REACH_POWER objectives consume the fresh value
  // (SET mode — monotonic). Same transaction as the mutation that caused it.
  await applyQuestEventInTx(tx, playerId, { kind: 'POWER_REACHED', power: power.total })
  return power.total
}
