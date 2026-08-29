/**
 * WARLORDS — Power computation weights (data-driven).
 *
 * Power is NEVER a stored, client-settable value: it is derived from the
 * player's real state (army + buildings + technologies) with the pure
 * functions below. The weights are the only tuning surface.
 *
 * Numeric policy: all weights are BASIS POINTS or integers — no floats in
 * the formula, so the same state always yields the exact same power.
 */

import type { BuildingType, TechBranch } from '@/lib/game/types/common'

export const POWER = {
  /** Relative value of one point of each unit stat (basis points). */
  unit: {
    attackBps: 10_000,
    defenseBps: 10_000,
    healthBps: 5_000,
    /** Each tier above 1 multiplies the unit's stats by +2000 bps. */
    tierBonusBps: 2_000,
  },
  /** Base power of a building at level 1 (scales linearly with level). */
  buildingWeight: {
    TOWN_HALL: 200,
    CASTLE: 250,
    BARRACKS: 150,
    ARCHER_CAMP: 100,
    STABLE: 100,
    ARMORY: 120,
    HOSPITAL: 90,
    FARM: 60,
    WOOD_MILL: 60,
    IRON_MINE: 70,
    GOLD_MINE: 70,
    ACADEMY: 110,
    SCOUT_CENTER: 50,
    SPY_CENTER: 50,
    WAREHOUSE: 60,
    MARKET: 60,
    WALL: 80,
  } as Record<BuildingType, number>,
  /** Power per researched level of a technology, by branch. */
  techBranchWeight: {
    MILITARY: 300,
    DEFENSE: 250,
    ECONOMY: 150,
    SCIENCE: 200,
    SCOUTING: 100,
  } as Record<TechBranch, number>,
} as const

/** Divisor when both a stat-weight and a tier multiplier are applied. */
const BPS = 10_000
const BPS_SQUARED = 100_000_000

export interface PowerUnitStats {
  attack: number
  defense: number
  health: number
  tier: number
}

/** Power of ONE unit of the given type (before multiplying by count). */
export function computeUnitBasePower(unit: PowerUnitStats): number {
  const w = POWER.unit
  const statPower =
    unit.attack * w.attackBps + unit.defense * w.defenseBps + unit.health * w.healthBps
  const tierMult = BPS + (Math.max(1, unit.tier) - 1) * w.tierBonusBps
  return Math.floor((statPower * tierMult) / BPS_SQUARED)
}

/** Power of a stack of `count` units of the given type. */
export function computeUnitStackPower(unit: PowerUnitStats, count: number): number {
  if (count <= 0) return 0
  return computeUnitBasePower(unit) * count
}

/** Power of one building of the given type and level. Unknown types weigh 0. */
export function computeBuildingPower(type: string, level: number): number {
  const weight = (POWER.buildingWeight as Record<string, number>)[type] ?? 0
  if (weight <= 0 || level <= 0) return 0
  return weight * level
}

/** Power of a researched technology level. Unknown branches weigh 0. */
export function computeTechPower(branch: string, level: number): number {
  const weight = (POWER.techBranchWeight as Record<string, number>)[branch] ?? 0
  if (weight <= 0 || level <= 0) return 0
  return weight * level
}

export interface PowerBreakdown {
  units: number
  buildings: number
  technologies: number
  total: number
}
