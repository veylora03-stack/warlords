/**
 * WARLORDS — XP / Level system (data-driven).
 *
 * Balance lives HERE, never in logic (docs/ARCHITECTURE.md): the curve
 * parameters below are the single tuning surface; everything else is derived
 * from them with pure integer math. Rebalancing never touches a service.
 *
 * Curve: the XP required to advance from level L to L+1 grows geometrically
 * (baseXp compounded by growthBps per level, floored to integers). The
 * per-level table is derived ONCE at module load — deterministic and cheap.
 *
 * XP totals are safe integers (< 2^53); the Player row stores them as BigInt
 * and conversion happens only at the persistence boundary.
 */

// ── Tuning surface ───────────────────────────────────────────────────────────

export const LEVELING = {
  /** Highest reachable level. XP beyond the cap is clamped (never wasted). */
  maxLevel: 30,
  /** XP needed to advance from level 1 to level 2. */
  baseXp: 100,
  /** Per-level growth of the requirement, in basis points (1200 = +12%). */
  growthBps: 1200,
} as const

/** Sanity invariant — a curve that cannot advance is a config bug. */
if (LEVELING.maxLevel < 2 || LEVELING.baseXp <= 0 || LEVELING.growthBps <= 0) {
  throw new Error('Invalid LEVELING config: maxLevel ≥ 2, baseXp > 0, growthBps > 0 required')
}

// ── Derived curve (do not edit — regenerate by changing the params above) ────

/**
 * XP required to advance FROM level index i (array position 0 = level 1 → 2).
 * Length is maxLevel - 1 (no requirement beyond the cap).
 */
export const XP_REQUIRED_PER_LEVEL: readonly number[] = (() => {
  const table: number[] = []
  let requirement: number = LEVELING.baseXp
  for (let i = 0; i < LEVELING.maxLevel - 1; i++) {
    table.push(requirement)
    requirement = Math.floor((requirement * (10_000 + LEVELING.growthBps)) / 10_000)
  }
  return table
})()

/** Cumulative XP needed to REACH each level. Index 0 = level 1 (always 0). */
export const CUMULATIVE_XP_BY_LEVEL: readonly number[] = (() => {
  const cumulative: number[] = [0]
  for (const requirement of XP_REQUIRED_PER_LEVEL) {
    cumulative.push(cumulative[cumulative.length - 1]! + requirement)
  }
  return cumulative
})()

/** Total XP a player can ever hold (clamped at the cap). */
export const MAX_TOTAL_XP: number = CUMULATIVE_XP_BY_LEVEL[LEVELING.maxLevel - 1]!

// ── Pure progression functions ───────────────────────────────────────────────

export interface LevelProgress {
  level: number
  /** Total XP held by the player (clamped to MAX_TOTAL_XP). */
  xp: number
  /** XP accumulated inside the current level. */
  xpIntoLevel: number
  /** XP required to advance from the current level (0 at max level). */
  xpForNextLevel: number
  /** Progress through the current level, in basis points (10000 = 100%). */
  progressBps: number
}

/**
 * Resolves the level state for a total XP amount. Levels start at 1.
 * Pure: no I/O, no mutation — services own persistence.
 */
export function resolveLevelProgress(totalXp: number): LevelProgress {
  const xp = Math.max(0, Math.min(Number(totalXp) || 0, MAX_TOTAL_XP))

  // Linear scan — maxLevel is tiny (30) and the table is module-cached.
  let level = 1
  while (level < LEVELING.maxLevel && xp >= CUMULATIVE_XP_BY_LEVEL[level]!) {
    level++
  }

  const xpIntoLevel = xp - CUMULATIVE_XP_BY_LEVEL[level - 1]!
  const xpForNextLevel = level >= LEVELING.maxLevel ? 0 : XP_REQUIRED_PER_LEVEL[level - 1]!
  const progressBps =
    level >= LEVELING.maxLevel || xpForNextLevel === 0
      ? 10_000
      : Math.floor((xpIntoLevel * 10_000) / xpForNextLevel)

  return { level, xp, xpIntoLevel, xpForNextLevel, progressBps }
}

export interface XpGainResult {
  /** Total XP after the gain (already clamped). */
  xp: number
  /** Level after the gain. */
  level: number
  /** How many levels were crossed by this gain (0 when none). */
  levelsGained: number
  /** Convenience flag: levelsGained > 0. */
  leveledUp: boolean
  /** True when the player sits at the level cap (further XP is clamped). */
  atMaxLevel: boolean
}

/**
 * Applies an XP gain to a (level, xp) pair. Pure — the caller persists.
 * `currentXp` is the authoritative total (level is derived, never trusted).
 */
export function applyXpGain(currentXp: number, gain: number): XpGainResult {
  if (!Number.isInteger(gain) || gain <= 0) {
    throw new RangeError(`XP gain must be a positive integer, got ${gain}`)
  }
  const before = resolveLevelProgress(currentXp)
  const after = resolveLevelProgress(before.xp + gain)
  return {
    xp: after.xp,
    level: after.level,
    levelsGained: after.level - before.level,
    leveledUp: after.level > before.level,
    atMaxLevel: after.level >= LEVELING.maxLevel,
  }
}
