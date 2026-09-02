/**
 * WARLORDS — Positional garrison configuration (Phase 34: Clans & Positional
 * Territory Garrisons).
 *
 * The ONLY place garrison balance/policy numbers live (ARCHITECTURE.md rule).
 * The march engine, garrison service and battle integration read this config;
 * rebalancing never touches logic. Everything gameplay-relevant is
 * SERVER-authoritative — the client can never state a capacity, a unit count
 * or an authorization (NEVER TRUST THE CLIENT).
 *
 * Capacity model (STEP 9 — minimal, deterministic, derived from EXISTING
 * architecture): a territory's positional capacity scales with its
 * `strategicValue` (the same generator-assigned field that sizes the virtual
 * NPC garrison and capture spoils). No separate progression system is
 * introduced:
 *
 *   capacity(territory) = capacityBase + capacityPerStrategicValue × strategicValue
 *
 * Capacity is checked TWICE by design: softly at march creation (fast
 * refusal) and authoritatively at arrival (the garrison may have changed
 * while the march was travelling). An over-capacity arrival bounces the
 * WHOLE detachment home — units are never split or dropped.
 */

/**
 * Garrison engine configuration — versioned as a whole. Bump `version`
 * whenever ANY value below changes.
 */
export const GARRISON = {
  /** Config snapshot version — bump whenever any policy below changes. */
  version: 1,

  /** Base positional capacity in units for any owned territory. */
  capacityBase: 400,
  /** Additional capacity per point of territory strategicValue (1..10). */
  capacityPerStrategicValue: 250,

  /** Max simultaneous contributions (deployed marches) on ONE territory —
   *  bounds the defense-side aggregation and the withdraw/casualty loops. */
  maxContributionsPerTerritory: 20,

  /** Idempotency/policy parity with marches: withdrawing is a state-machine
   *  claim (ARRIVED → RETURNING), so no separate TTL config is needed. */
} as const

export type GarrisonPolicy = typeof GARRISON

/** The pure capacity function — unit-tested; the ONLY capacity authority. */
export function garrisonCapacity(strategicValue: number): number {
  const sv = Math.max(0, Math.min(10, Math.floor(strategicValue)))
  return GARRISON.capacityBase + GARRISON.capacityPerStrategicValue * sv
}

/** Invariants — a broken config must fail fast at first import. */
;((): void => {
  const problems: string[] = []
  if (!Number.isInteger(GARRISON.version) || GARRISON.version < 1)
    problems.push('version must be a positive integer')
  if (!Number.isInteger(GARRISON.capacityBase) || GARRISON.capacityBase < 1)
    problems.push('capacityBase must be a positive integer')
  if (
    !Number.isInteger(GARRISON.capacityPerStrategicValue) ||
    GARRISON.capacityPerStrategicValue < 0
  )
    problems.push('capacityPerStrategicValue must be a non-negative integer')
  if (
    !Number.isInteger(GARRISON.maxContributionsPerTerritory) ||
    GARRISON.maxContributionsPerTerritory < 1 ||
    GARRISON.maxContributionsPerTerritory > 100
  )
    problems.push('maxContributionsPerTerritory out of range')
  if (problems.length > 0) throw new Error(`Invalid GARRISON config: ${problems.join('; ')}`)
})()
