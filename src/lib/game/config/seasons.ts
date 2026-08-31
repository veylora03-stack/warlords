/**
 * WARLORDS — Season system configuration (Phase 20).
 *
 * EVERY number that governs seasons lives HERE and only here — lifecycle
 * durations, score sources, reward tiers, the reset policy. Services read
 * this config; rebalancing never touches logic. The active season's config
 * is SNAPSHOTTED onto its row at creation, so mid-season balance edits can
 * never retroactively alter a running season's rules or rewards.
 *
 * Numeric policy: points and reward amounts are integers; no floats.
 */

import { ECONOMY_RESOURCES, type EconomyResource } from './economy'
import { REWARD_KEYS } from './quests'

// ── Rarity ladder (shared by titles + cosmetics) ─────────────────────────────

export const SEASON_RARITIES = [
  'COMMON',
  'UNCOMMON',
  'RARE',
  'EPIC',
  'LEGENDARY',
  'MYTHIC',
] as const
export type SeasonRarity = (typeof SEASON_RARITIES)[number]

export const COSMETIC_KINDS = ['AVATAR_FRAME', 'BANNER', 'CITY_THEME', 'EMBLEM'] as const
export type CosmeticKind = (typeof COSMETIC_KINDS)[number]

export const PROGRESSION_SOURCES = ['SEASON_RANK', 'ACHIEVEMENT', 'SHOP'] as const
export type ProgressionSource = (typeof PROGRESSION_SOURCES)[number]

// ── Reward tiers ─────────────────────────────────────────────────────────────

/** Resource payout of one reward tier (positive integers; validated invariants below). */
export type SeasonResourceRewards = Partial<Record<EconomyResource, number>>

export interface SeasonRewardTier {
  /** Human tier name shown in the UI + stored on the claim row. */
  name: string
  /** Inclusive 1-based rank range covered by this tier. */
  fromRank: number
  toRank: number
  /** Resource payout granted at claim time through the ledger. */
  resources: SeasonResourceRewards
  /** Permanent-progression grants applied by the settlement transaction. */
  titleIds: string[]
  cosmeticIds: string[]
  /** Achievement unlocked at settlement for this tier (achievement catalog id). */
  achievementIds: string[]
}

// ── Reset policy (what the transactional wipe touches — and preserves) ───────

/**
 * Catalog of table/field groups the reset wipes. Data-driven: future phases
 * register additional seasonal systems by extending this list — the reset
 * transaction walks the CATALOG, never hard-coded table names.
 */
export const SEASONAL_RESET_CATALOG = [
  'PLAYER_SEASON_POINTS',
  'TERRITORY_OWNERSHIP',
  'SEASON_WALLETS',
  'SEASONAL_COMMANDERS',
] as const
export type SeasonalResetAction = (typeof SEASONAL_RESET_CATALOG)[number]

/** Permanent progression — asserted (by tests + the settlement invariant) to survive every reset. */
export const PERMANENT_PROGRESSION_CATALOG = [
  'ACHIEVEMENTS',
  'COSMETICS',
  'TITLES',
  'PERMANENT_COMMANDERS',
  'WALLETS',
  'BUILDINGS',
  'UNITS',
  'POWER_LEVEL_XP',
] as const
export type PermanentProgression = (typeof PERMANENT_PROGRESSION_CATALOG)[number]

// ── Season rules ─────────────────────────────────────────────────────────────

export interface SeasonScoreRules {
  /** Points awarded when a construction claim applies the new level. */
  buildingLevelUpPointsPerNewLevel: number
  /** Points per trained unit by unit tier (index = tier − 1). */
  unitTrainedPointsPerTier: number[]
}

export interface SeasonRules {
  /** Season length in days (endsAt = startsAt + days). */
  durationDays: number
  /** Naming pattern; `{n}` is replaced with the season number. */
  namePattern: string
  score: SeasonScoreRules
  rewardTiers: SeasonRewardTier[]
  /** Deterministic tie-break for equal scores: earlier join (createdAt, then id). */
  tieBreak: 'EARLIER_JOIN'
  /** Only players with at least this many season points are ranked. */
  minScoreToRank: number
}

export const SEASON_RULES: SeasonRules = {
  durationDays: 30,
  namePattern: 'Season {n}',
  score: {
    buildingLevelUpPointsPerNewLevel: 10,
    unitTrainedPointsPerTier: [2, 5, 10],
  },
  rewardTiers: [
    {
      name: 'Warlord Elite',
      fromRank: 1,
      toRank: 3,
      resources: { GOLD: 5000, CRYSTAL: 50, GEMS: 200 },
      titleIds: ['title-season-champion'],
      cosmeticIds: ['cosmetic-golden-emblem'],
      achievementIds: ['ach-season-champion'],
    },
    {
      name: 'Frontline Commander',
      fromRank: 4,
      toRank: 10,
      resources: { GOLD: 2500, CRYSTAL: 25, GEMS: 100 },
      titleIds: ['title-season-vanguard'],
      cosmeticIds: ['cosmetic-silver-banner'],
      achievementIds: [],
    },
    {
      name: 'Seasoned Warrior',
      fromRank: 11,
      toRank: 50,
      resources: { GOLD: 1000, CRYSTAL: 10, GEMS: 40 },
      titleIds: [],
      cosmeticIds: ['cosmetic-bronze-frame'],
      achievementIds: [],
    },
  ],
  tieBreak: 'EARLIER_JOIN',
  minScoreToRank: 1,
}

/** Titles catalog (seeded; permanent once earned). */
export interface TitleCatalogEntry {
  id: string
  name: string
  rarity: SeasonRarity
  source: ProgressionSource
  sortOrder: number
}

export const TITLES: TitleCatalogEntry[] = [
  {
    id: 'title-season-champion',
    name: 'Season Champion',
    rarity: 'LEGENDARY',
    source: 'SEASON_RANK',
    sortOrder: 1,
  },
  {
    id: 'title-season-vanguard',
    name: 'Season Vanguard',
    rarity: 'EPIC',
    source: 'SEASON_RANK',
    sortOrder: 2,
  },
  {
    id: 'title-season-veteran',
    name: 'Season Veteran',
    rarity: 'RARE',
    source: 'SEASON_RANK',
    sortOrder: 3,
  },
]

/** Cosmetics catalog (seeded; permanent once earned). */
export interface CosmeticCatalogEntry {
  id: string
  name: string
  kind: CosmeticKind
  rarity: SeasonRarity
  source: ProgressionSource
}

export const COSMETICS: CosmeticCatalogEntry[] = [
  {
    id: 'cosmetic-golden-emblem',
    name: 'Golden Emblem',
    kind: 'EMBLEM',
    rarity: 'LEGENDARY',
    source: 'SEASON_RANK',
  },
  {
    id: 'cosmetic-silver-banner',
    name: 'Silver Banner',
    kind: 'BANNER',
    rarity: 'EPIC',
    source: 'SEASON_RANK',
  },
  {
    id: 'cosmetic-bronze-frame',
    name: 'Bronze Frame',
    kind: 'AVATAR_FRAME',
    rarity: 'RARE',
    source: 'SEASON_RANK',
  },
  {
    id: 'cosmetic-founding-lord',
    name: 'Founding Lord Frame',
    kind: 'AVATAR_FRAME',
    rarity: 'MYTHIC',
    source: 'ACHIEVEMENT',
  },
]

// ── Invariant validation (fail fast on config edits) ─────────────────────────

/**
 * Throws on any rule violation. Called by the unit config tests AND lazily by
 * the services (memoized) so a broken config can never reach the database.
 */
export function validateSeasonRules(rules: SeasonRules = SEASON_RULES): string[] {
  const problems: string[] = []
  if (!Number.isInteger(rules.durationDays) || rules.durationDays < 1 || rules.durationDays > 366) {
    problems.push('durationDays must be an integer 1…366')
  }
  if (!rules.namePattern.includes('{n}')) problems.push('namePattern must contain {n}')
  if (!Number.isInteger(rules.minScoreToRank) || rules.minScoreToRank < 0) {
    problems.push('minScoreToRank must be a non-negative integer')
  }
  if (rules.tieBreak !== 'EARLIER_JOIN') problems.push('unknown tieBreak policy')

  const tierLadder = rules.rewardTiers
  let expectedRank = 1
  tierLadder.forEach((tier, index) => {
    if (!Number.isInteger(tier.fromRank) || !Number.isInteger(tier.toRank)) {
      problems.push(`tier ${index}: rank bounds must be integers`)
      return
    }
    if (tier.fromRank !== expectedRank) {
      problems.push(
        `tier ${index} (${tier.name}): expected fromRank ${expectedRank}, got ${tier.fromRank}`,
      )
    }
    if (tier.toRank < tier.fromRank) {
      problems.push(`tier ${index} (${tier.name}): toRank below fromRank`)
    }
    expectedRank = tier.toRank + 1

    for (const [resource, amount] of Object.entries(tier.resources)) {
      if (!(ECONOMY_RESOURCES as readonly string[]).includes(resource)) {
        problems.push(`tier ${index} (${tier.name}): unknown resource ${resource}`)
      }
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
        problems.push(`tier ${index} (${tier.name}): ${resource} must be a positive integer`)
      }
    }
    for (const key of ['titleIds', 'cosmeticIds', 'achievementIds'] as const) {
      if (new Set(tier[key]).size !== tier[key].length) {
        problems.push(`tier ${index} (${tier.name}): duplicate entries in ${key}`)
      }
    }
  })

  if (rules.score.buildingLevelUpPointsPerNewLevel <= 0) {
    problems.push('buildingLevelUpPointsPerNewLevel must be positive')
  }
  if (
    rules.score.unitTrainedPointsPerTier.length === 0 ||
    rules.score.unitTrainedPointsPerTier.some((p) => !Number.isInteger(p) || p <= 0)
  ) {
    problems.push('unitTrainedPointsPerTier must be a non-empty list of positive integers')
  }

  return problems
}

/** True when every reward key referenced anywhere is a real economy resource. */
export function seasonRewardKeysAreValid(rules: SeasonRules = SEASON_RULES): boolean {
  return rules.rewardTiers.every((tier) =>
    Object.keys(tier.resources).every((key) =>
      (ECONOMY_RESOURCES as readonly string[]).includes(key),
    ),
  )
}

/** REWARD_KEYS intersection check — quests reward keys stay compatible. */
export function seasonRewardKeysSubsetOfQuestKeys(rules: SeasonRules = SEASON_RULES): boolean {
  const questKeys = new Set<string>(REWARD_KEYS)
  return rules.rewardTiers
    .flatMap((tier) => Object.keys(tier.resources))
    .every((key) => questKeys.has(key))
}

/** Points for a building reaching `newLevel` (server-computed, data-driven). */
export function seasonPointsForBuildingLevelUp(
  newLevel: number,
  rules: SeasonRules = SEASON_RULES,
): number {
  return rules.score.buildingLevelUpPointsPerNewLevel * newLevel
}

/** Points for a completed training batch (server-computed, data-driven). */
export function seasonPointsForTrainedUnits(
  tier: number,
  count: number,
  rules: SeasonRules = SEASON_RULES,
): number {
  const perUnit =
    rules.score.unitTrainedPointsPerTier[
      Math.min(Math.max(tier, 1), rules.score.unitTrainedPointsPerTier.length) - 1
    ]
  return perUnit * count
}

/** The tier covering `rank` (null → unranked payout). */
export function seasonTierForRank(
  rank: number,
  rules: SeasonRules = SEASON_RULES,
): SeasonRewardTier | null {
  return rules.rewardTiers.find((tier) => rank >= tier.fromRank && rank <= tier.toRank) ?? null
}
