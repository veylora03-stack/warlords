/**
 * WARLORDS — Player statistics catalog (data-driven).
 *
 * Statistics are append-only integer counters stored on `Player.stats` (JSON).
 * The definitions below are the SINGLE source of truth: the read path
 * normalizes any stored blob against this catalog (corrupt/legacy/unknown
 * fields are dropped, missing fields zero-fill), and the write path rejects
 * deltas for keys that are not defined here.
 *
 * Counters never decrease — deltas must be positive integers. Negative or
 * fractional adjustments would open state-tampering paths.
 */

export const STAT_CATEGORIES = ['COMBAT', 'ECONOMY', 'PROGRESSION'] as const
export type StatCategory = (typeof STAT_CATEGORIES)[number]

export interface StatDefinition {
  key: string
  label: string
  category: StatCategory
}

export const STAT_DEFINITIONS: readonly StatDefinition[] = [
  { key: 'battlesWon', label: 'Battles won', category: 'COMBAT' },
  { key: 'battlesLost', label: 'Battles lost', category: 'COMBAT' },
  { key: 'attacksLaunched', label: 'Attacks launched', category: 'COMBAT' },
  { key: 'defensesWon', label: 'Defenses won', category: 'COMBAT' },
  { key: 'territoriesCaptured', label: 'Territories captured', category: 'COMBAT' },
  { key: 'territoriesDefended', label: 'Territories defended', category: 'COMBAT' },
  { key: 'territoriesLost', label: 'Territories lost', category: 'COMBAT' },
  { key: 'unitsTrained', label: 'Units trained', category: 'COMBAT' },
  { key: 'unitsLost', label: 'Units lost', category: 'COMBAT' },
  { key: 'resourcesCollected', label: 'Resources collected', category: 'ECONOMY' },
  { key: 'resourcesPlundered', label: 'Resources plundered', category: 'ECONOMY' },
  { key: 'resourcesSpent', label: 'Resources spent', category: 'ECONOMY' },
  { key: 'buildingsConstructed', label: 'Buildings constructed', category: 'PROGRESSION' },
  { key: 'technologiesResearched', label: 'Technologies researched', category: 'PROGRESSION' },
  { key: 'questsCompleted', label: 'Quests completed', category: 'PROGRESSION' },
] as const

export const STAT_KEYS: readonly string[] = STAT_DEFINITIONS.map((d) => d.key)

/** Zero-filled, fully-normalized statistics record. */
export function emptyPlayerStats(): Record<string, number> {
  const stats: Record<string, number> = {}
  for (const def of STAT_DEFINITIONS) stats[def.key] = 0
  return stats
}
