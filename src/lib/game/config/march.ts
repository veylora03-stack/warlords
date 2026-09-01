/**
 * WARLORDS — March configuration (Phase 33: March & Army Movement Engine).
 *
 * The ONLY place movement balance/policy numbers live (ARCHITECTURE.md rule).
 * The march engine and service read this config; rebalancing never touches
 * logic. Everything gameplay-relevant is SERVER-authoritative: the client may
 * request a destination, an action, units and an idempotency key — distance,
 * speed, terrain, travel time, arrival, battle outcome, survivors and every
 * restoration are derived HERE and in the services (NEVER TRUST THE CLIENT).
 *
 * Numeric policy: speeds/costs are BASIS POINTS (10_000 bps = 100%); time is
 * integer seconds; unit speeds come from the unit catalog (config/units.ts).
 * Terrain move costs live in config/world.ts (TERRAIN[*].moveCostBps) — the
 * single terrain catalog is never duplicated.
 *
 * Travel-time model (deterministic, integer-safe):
 *
 *   distance          = |dx| + |dy|                    (Manhattan — the world
 *                                                       moves 4-directionally,
 *                                                       no diagonals exist)
 *   armySpeed         = min(unit.speed over committed stacks)
 *   armySpeedFactorBps = clamp(round(referenceSpeed × 10_000 / armySpeed),
 *                             minSpeedFactorBps, maxSpeedFactorBps)
 *   scoutBonusBps     = SCOUT only: clamp(scoutSpeedBps, 10_000, max)
 *                       (from the SCOUT_CENTER building effect — reserved
 *                       extension point consumed)
 *   travelSeconds     = clamp(
 *       ceil(distance × secondsPerCell
 *            × destinationTerrainMoveCostBps / 10_000
 *            × armySpeedFactorBps / 10_000
 *            × 10_000 / scoutBonusBps),
 *       minTravelSeconds, maxTravelSeconds)
 *
 * The RETURN leg uses the SURVIVING composition (slowest survivor) and the
 * origin cell terrain (CITY — 10_000 bps neutral).
 */

import { effectsFor } from './buildings'
import { TERRAIN } from './world'
import type { TerrainType } from '@/lib/game/types/battle'

/**
 * March engine configuration — versioned as a whole. Bump `version` whenever
 * ANY value below changes: the old snapshot stays on existing marches.
 */
export const MARCH = {
  /** Config snapshot version — bump whenever any policy below changes. */
  version: 1,

  /** Base travel seconds per Manhattan grid cell at the reference speed. */
  secondsPerCell: 20,
  /** A unit with this catalog `speed` marches at exactly `secondsPerCell`. */
  referenceSpeed: 5,

  /** Slowest army pace factor (bps): an army of speed-1 units marches at 2× the reference time... bounded so marches stay scheduleable. */
  minSpeedFactorBps: 2_000,
  /** Fastest army pace factor (bps): speed is capped at 2× the reference pace. */
  maxSpeedFactorBps: 20_000,

  /** Even an adjacent-cell hop takes at least this long (rushed departure). */
  minTravelSeconds: 30,
  /** Hard travel-time bound (6h) — cross-world marches are clamped here. */
  maxTravelSeconds: 21_600,

  /** Max total units on ONE expedition (bounds reservation + battle cost). */
  maxUnitsPerMarch: 5_000,
  /** Max distinct unit stacks per expedition (payload sanity). */
  maxStacksPerMarch: 8,

  /** Energy cost of repositioning marches (DEFEND/REINFORCE). */
  repositionEnergyCost: 5,

  /** Cancel policy: mobilization is NEVER refunded (documented decision —
   *  cancelling an in-flight army cannot be exploited for free scouting). */
  cancelRefundEnergyBps: 0,

  /** Scout reports expire after this many hours (intel goes stale). */
  scoutReportTtlHours: 24,

  /** Idempotency (creation double-click/retry protection) — same policy as battles. */
  idempotency: {
    ttlSeconds: 86_400,
    keyMaxLength: 64,
  },
} as const

export type MarchPolicy = typeof MARCH

/** Resolved travel-time inputs — all server-derived, all integers. */
export interface TravelTimeInput {
  /** Manhattan cell distance (≥ 1 for real marches). */
  distance: number
  /** Slowest unit speed in the committed (or surviving) army (≥ 1). */
  armySpeed: number
  /** Destination terrain key (TERRAIN catalog — moveCostBps). */
  destinationTerrain: TerrainType
  /** SCOUT only: SCOUT_CENTER scoutSpeedBps effect (undefined → no bonus). */
  scoutSpeedBps?: number
}

/** The pure travel-time function — unit-tested; the ONLY timing authority. */
export function marchTravelSeconds(input: TravelTimeInput): number {
  const terrainBps = TERRAIN[input.destinationTerrain]?.moveCostBps ?? 10_000
  const speed = Math.max(1, Math.floor(input.armySpeed))
  const armyFactor = Math.min(
    MARCH.maxSpeedFactorBps,
    Math.max(MARCH.minSpeedFactorBps, Math.round((MARCH.referenceSpeed * 10_000) / speed)),
  )
  const scoutBonus =
    typeof input.scoutSpeedBps === 'number' && input.scoutSpeedBps > 0
      ? Math.min(Math.max(Math.floor(input.scoutSpeedBps), 10_000), MARCH.maxSpeedFactorBps)
      : 10_000
  const raw =
    input.distance *
    MARCH.secondsPerCell *
    (terrainBps / 10_000) *
    (armyFactor / 10_000) *
    (10_000 / scoutBonus)
  const seconds = Math.ceil(raw)
  return Math.min(MARCH.maxTravelSeconds, Math.max(MARCH.minTravelSeconds, seconds))
}

/** SCOUT_CENTER effect lookup for scout marches (level ≥ 1 → ≥ 10_000 bps). */
export function scoutSpeedBonusBps(scoutCenterLevel: number): number {
  const effects = effectsFor('SCOUT_CENTER', Math.max(1, scoutCenterLevel))
  const bps = effects['scoutSpeedBps']
  return typeof bps === 'number' && bps > 0 ? bps : 10_000
}

/** Invariants — a broken config must fail fast at first import. */
;((): void => {
  const problems: string[] = []
  if (!Number.isInteger(MARCH.version) || MARCH.version < 1)
    problems.push('version must be a positive integer')
  if (MARCH.secondsPerCell < 1) problems.push('secondsPerCell must be >= 1')
  if (MARCH.referenceSpeed < 1) problems.push('referenceSpeed must be >= 1')
  if (MARCH.minSpeedFactorBps < 1_000 || MARCH.minSpeedFactorBps > MARCH.maxSpeedFactorBps)
    problems.push('minSpeedFactorBps out of range')
  if (MARCH.maxSpeedFactorBps > 100_000) problems.push('maxSpeedFactorBps too large')
  if (MARCH.minTravelSeconds < 1) problems.push('minTravelSeconds must be >= 1')
  if (MARCH.maxTravelSeconds <= MARCH.minTravelSeconds)
    problems.push('maxTravelSeconds must exceed minTravelSeconds')
  if (MARCH.maxUnitsPerMarch < 1) problems.push('maxUnitsPerMarch must be >= 1')
  if (MARCH.maxStacksPerMarch < 1 || MARCH.maxStacksPerMarch > 32)
    problems.push('maxStacksPerMarch out of range')
  if (MARCH.repositionEnergyCost < 0) problems.push('repositionEnergyCost must be >= 0')
  if (MARCH.cancelRefundEnergyBps !== 0)
    problems.push('cancelRefundEnergyBps is fixed at 0 (mobilization is never refunded)')
  if (!Number.isInteger(MARCH.scoutReportTtlHours) || MARCH.scoutReportTtlHours < 1)
    problems.push('scoutReportTtlHours must be an integer >= 1')
  if (!Number.isInteger(MARCH.idempotency.ttlSeconds) || MARCH.idempotency.ttlSeconds < 60)
    problems.push('idempotency.ttlSeconds must be an integer >= 60')
  if (!Number.isInteger(MARCH.idempotency.keyMaxLength) || MARCH.idempotency.keyMaxLength < 8)
    problems.push('idempotency.keyMaxLength must be an integer >= 8')
  if (problems.length > 0) throw new Error(`Invalid MARCH config: ${problems.join('; ')}`)
})()
