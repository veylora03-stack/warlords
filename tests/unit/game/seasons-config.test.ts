/**
 * Unit tests — Season system configuration invariants (config/seasons.ts).
 *
 * The config is the ONLY tuning surface; these invariants keep it honest:
 * tier ladders must be contiguous from rank 1, every reward key must be a
 * real economy resource, the reset/permanent catalogs must be disjoint and
 * complete, and the point helpers must be deterministic.
 */

import { describe, it, expect } from 'bun:test'
import {
  COSMETICS,
  COSMETIC_KINDS,
  PERMANENT_PROGRESSION_CATALOG,
  SEASONAL_RESET_CATALOG,
  SEASON_RARITIES,
  SEASON_RULES,
  TITLES,
  seasonPointsForBuildingLevelUp,
  seasonPointsForTrainedUnits,
  seasonRewardKeysAreValid,
  seasonRewardKeysSubsetOfQuestKeys,
  seasonTierForRank,
  validateSeasonRules,
} from '../../../src/lib/game/config/seasons'
import { ECONOMY_RESOURCES } from '../../../src/lib/game/config/economy'
import { UNITS } from '../../../src/lib/game/config/units'
import { ACHIEVEMENTS } from '../../../src/lib/game/config/achievements'

describe('SEASON_RULES invariants', () => {
  it('passes the built-in validator', () => {
    expect(validateSeasonRules()).toEqual([])
  })

  it('has a sane duration and naming pattern', () => {
    expect(SEASON_RULES.durationDays).toBeGreaterThanOrEqual(1)
    expect(SEASON_RULES.durationDays).toBeLessThanOrEqual(366)
    expect(SEASON_RULES.namePattern).toContain('{n}')
  })

  it('tier ladder is contiguous from rank 1 with no gaps or overlaps', () => {
    let expected = 1
    for (const tier of SEASON_RULES.rewardTiers) {
      expect(tier.fromRank).toBe(expected)
      expect(tier.toRank).toBeGreaterThanOrEqual(tier.fromRank)
      expected = tier.toRank + 1
    }
    expect(SEASON_RULES.rewardTiers.length).toBeGreaterThan(0)
  })

  it('every resource reward is a positive integer over a real economy resource', () => {
    for (const tier of SEASON_RULES.rewardTiers) {
      for (const [resource, amount] of Object.entries(tier.resources)) {
        expect(ECONOMY_RESOURCES).toContain(resource)
        expect(Number.isInteger(amount)).toBe(true)
        expect(amount).toBeGreaterThan(0)
      }
    }
    expect(seasonRewardKeysAreValid()).toBe(true)
    expect(seasonRewardKeysSubsetOfQuestKeys()).toBe(true)
  })

  it('every referenced title/cosmetic/achievement exists in its catalog', () => {
    const titleIds = new Set(TITLES.map((t) => t.id))
    const cosmeticIds = new Set(COSMETICS.map((c) => c.id))
    const achievementIds = new Set(ACHIEVEMENTS.map((a) => a.id))
    for (const tier of SEASON_RULES.rewardTiers) {
      for (const id of tier.titleIds) expect(titleIds.has(id)).toBe(true)
      for (const id of tier.cosmeticIds) expect(cosmeticIds.has(id)).toBe(true)
      for (const id of tier.achievementIds) expect(achievementIds.has(id)).toBe(true)
    }
  })

  it('top rank always receives the first tier (rank 1 is rewarded)', () => {
    expect(seasonTierForRank(1)).not.toBeNull()
    expect(seasonTierForRank(0)).toBeNull()
    expect(seasonTierForRank(-1)).toBeNull()
    expect(seasonTierForRank(Number.MAX_SAFE_INTEGER)).toBeNull()
  })

  it('reset and permanent catalogs are disjoint and non-empty', () => {
    expect(SEASONAL_RESET_CATALOG.length).toBeGreaterThan(0)
    expect(PERMANENT_PROGRESSION_CATALOG.length).toBeGreaterThan(0)
    const seasonal = new Set<string>(SEASONAL_RESET_CATALOG)
    for (const entry of PERMANENT_PROGRESSION_CATALOG) {
      expect(seasonal.has(entry)).toBe(false)
    }
  })

  it('permanent catalog names exactly the user contract (achievements · cosmetics · titles · certain commanders · economy)', () => {
    for (const required of ['ACHIEVEMENTS', 'COSMETICS', 'TITLES', 'PERMANENT_COMMANDERS']) {
      expect(PERMANENT_PROGRESSION_CATALOG).toContain(required)
    }
  })

  it('seasonal catalog names exactly the user contract (season rank · territory · season resources)', () => {
    for (const required of [
      'PLAYER_SEASON_POINTS',
      'TERRITORY_OWNERSHIP',
      'SEASON_WALLETS',
      'SEASONAL_COMMANDERS',
    ]) {
      expect(SEASONAL_RESET_CATALOG).toContain(required)
    }
  })

  it('validator rejects broken configs (each invariant has teeth)', () => {
    expect(validateSeasonRules({ ...SEASON_RULES, durationDays: 0 })).not.toEqual([])
    expect(validateSeasonRules({ ...SEASON_RULES, namePattern: 'Season' })).not.toEqual([])
    expect(
      validateSeasonRules({
        ...SEASON_RULES,
        rewardTiers: [{ ...SEASON_RULES.rewardTiers[0], fromRank: 2 }],
      }),
    ).not.toEqual([])
    expect(
      validateSeasonRules({
        ...SEASON_RULES,
        rewardTiers: [
          {
            ...SEASON_RULES.rewardTiers[0],
            resources: { GOLD: -5 },
          },
        ],
      }),
    ).not.toEqual([])
    expect(
      validateSeasonRules({
        ...SEASON_RULES,
        rewardTiers: [
          {
            ...SEASON_RULES.rewardTiers[0],
            resources: { NOT_A_RESOURCE: 5 } as Record<string, number>,
          },
        ],
      }),
    ).not.toEqual([])
    expect(
      validateSeasonRules({
        ...SEASON_RULES,
        score: { ...SEASON_RULES.score, buildingLevelUpPointsPerNewLevel: 0 },
      }),
    ).not.toEqual([])
    expect(
      validateSeasonRules({
        ...SEASON_RULES,
        score: { ...SEASON_RULES.score, unitTrainedPointsPerTier: [] },
      }),
    ).not.toEqual([])
  })
})

describe('season point helpers (data-driven, deterministic)', () => {
  it('building level-up points scale with the new level', () => {
    expect(seasonPointsForBuildingLevelUp(1)).toBe(
      SEASON_RULES.score.buildingLevelUpPointsPerNewLevel,
    )
    expect(seasonPointsForBuildingLevelUp(5)).toBe(
      5 * SEASON_RULES.score.buildingLevelUpPointsPerNewLevel,
    )
  })

  it('training points follow the per-tier table exactly', () => {
    SEASON_RULES.score.unitTrainedPointsPerTier.forEach((perUnit, index) => {
      expect(seasonPointsForTrainedUnits(index + 1, 1)).toBe(perUnit)
      expect(seasonPointsForTrainedUnits(index + 1, 10)).toBe(perUnit * 10)
    })
  })

  it('training points clamp out-of-range tiers to the table bounds', () => {
    const tiers = SEASON_RULES.score.unitTrainedPointsPerTier
    expect(seasonPointsForTrainedUnits(0, 1)).toBe(tiers[0])
    expect(seasonPointsForTrainedUnits(tiers.length + 5, 1)).toBe(tiers[tiers.length - 1])
  })

  it('every unit tier in the roster is covered by the points table', () => {
    const maxTier = Math.max(...UNITS.map((u) => u.tier))
    expect(SEASON_RULES.score.unitTrainedPointsPerTier.length).toBeGreaterThanOrEqual(maxTier)
  })
})

describe('title & cosmetic catalogs', () => {
  it('have unique ids and valid rarities', () => {
    expect(new Set(TITLES.map((t) => t.id)).size).toBe(TITLES.length)
    expect(new Set(COSMETICS.map((c) => c.id)).size).toBe(COSMETICS.length)
    for (const t of TITLES) expect(SEASON_RARITIES).toContain(t.rarity)
    for (const c of COSMETICS) {
      expect(SEASON_RARITIES).toContain(c.rarity)
      expect(COSMETIC_KINDS).toContain(c.kind)
    }
  })

  it('season-reward titles/cosmetics declare the SEASON_RANK source', () => {
    for (const tier of SEASON_RULES.rewardTiers) {
      for (const id of tier.titleIds) {
        expect(TITLES.find((t) => t.id === id)?.source).toBe('SEASON_RANK')
      }
      for (const id of tier.cosmeticIds) {
        expect(COSMETICS.find((c) => c.id === id)?.source).toBe('SEASON_RANK')
      }
    }
  })
})
