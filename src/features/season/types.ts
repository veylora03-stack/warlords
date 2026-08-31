/**
 * WARLORDS — Season feature types (mirror of the server DTOs).
 *
 * Amounts cross the API as strings (BigInt policy). The season lifecycle,
 * ranking, rewards and reset policy are ALL server-owned — the UI renders
 * state and issues intents only (claim · equip title).
 */

export type SeasonStatus = 'UPCOMING' | 'ACTIVE' | 'FINISHED'

export interface SeasonTierPreview {
  name: string
  fromRank: number
  toRank: number
  resources: Record<string, number>
  titles: string[]
  cosmetics: string[]
}

export interface SeasonView {
  season: {
    id: string
    number: number
    name: string
    status: SeasonStatus
    startsAt: string
    endsAt: string
    timeLeftSec: number | null
    settledAt: string | null
  } | null
  rules: {
    durationDays: number
    score: {
      buildingLevelUpPointsPerNewLevel: number
      unitTrainedPointsPerTier: number[]
    }
    rewardTiers: SeasonTierPreview[]
    permanentProgression: string[]
    seasonalReset: string[]
  }
  me: {
    seasonPoints: number
    rank: number | null
    shards: string
  }
  settlementPending: boolean
}

export interface RankedRow {
  rank: number
  playerId: string
  playerName: string
  score: number
  tier: string | null
}

export interface SeasonRankingView {
  seasonId: string
  seasonNumber: number
  seasonStatus: SeasonStatus
  live: RankedRow[]
  history: RankedRow[] | null
  me: { rank: number | null; score: number }
}

export interface SeasonRewardPayout {
  seasonId: string
  seasonNumber: number
  rank: number
  score: number
  tierName: string
  rewards: Record<string, number>
  claimedAt: string | null
}

export interface SeasonRewardsView {
  pending: SeasonRewardPayout[]
  claimed: SeasonRewardPayout[]
}

export interface ClaimSeasonRewardResult {
  claim: SeasonRewardPayout
  alreadyClaimed: boolean
  balances: Record<string, string>
}

export interface ProgressionTitle {
  id: string
  name: string
  rarity: string
  unlockedAt: string
  acquiredSeason: number | null
  active: boolean
}

export interface ProgressionCosmetic {
  id: string
  name: string
  kind: string
  rarity: string
  unlockedAt: string
  acquiredSeason: number | null
}

export interface ProgressionAchievement {
  id: string
  title: string
  description: string
  unlockedAt: string
}

export interface ProgressionCommander {
  id: string
  name: string
  rarity: string
  level: number
  seasonal: boolean
  unlockedAt: string
}

export interface SeasonProgressionView {
  titles: ProgressionTitle[]
  cosmetics: ProgressionCosmetic[]
  achievements: ProgressionAchievement[]
  commanders: ProgressionCommander[]
  equippedTitleId: string | null
}
