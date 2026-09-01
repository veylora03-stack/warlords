/**
 * WARLORDS — Achievement catalog (Phase 31: Quest + Achievement Engine).
 * Data source for the `achievements` table seed. Unlocks are evaluated
 * server-side from persisted state (Player.stats counters, player columns,
 * building levels, season settlement ranks) — never from client claims.
 *
 * Achievements are PERMANENT: they never reset with daily/weekly cycles and
 * persist across seasons (matching the permanent progression model). The
 * unlock is exactly-once by the PlayerAchievement DB unique constraint and
 * the reward is granted automatically at unlock through the Economy/Ledger
 * (ACHIEVEMENT_REWARD reason) — no claim step, no client involvement.
 *
 * Metrics (Achievement.metric / Achievement.meta):
 *  - STAT            → Player.stats[meta.statKey] (append-only counters)
 *  - BUILDING_LEVEL  → city building level (meta.buildingType)
 *  - PLAYER_LEVEL    → player.level
 *  - PLAYER_POWER    → player.power
 *  - SEASON_TOP      → final season rank ≤ meta.rank (evaluated at settlement)
 *
 * TERRITORY achievements (FIRST_TERRITORY / 10_TERRITORIES) are intentionally
 * NOT seeded — the World/Territory engine has not landed in this repository.
 */

import type { RewardKey } from './quests'

export const ACHIEVEMENT_CATEGORIES = [
  'PROGRESS',
  'MILITARY',
  'ECONOMY',
  'SOCIAL',
  'COLLECTION',
] as const
export type AchievementCategory = (typeof ACHIEVEMENT_CATEGORIES)[number]

export const ACHIEVEMENT_METRICS = [
  'STAT',
  'BUILDING_LEVEL',
  'PLAYER_LEVEL',
  'PLAYER_POWER',
  'SEASON_TOP',
] as const
export type AchievementMetric = (typeof ACHIEVEMENT_METRICS)[number]

export interface AchievementCatalogEntry {
  id: string
  title: string
  description: string
  category: AchievementCategory
  metric: AchievementMetric
  meta?: { statKey?: string; buildingType?: string; rank?: number }
  target: number
  reward: Partial<Record<RewardKey, number>>
}

export const ACHIEVEMENTS: AchievementCatalogEntry[] = [
  {
    id: 'ach-first-blood',
    title: 'First Blood',
    description: 'Win your first battle.',
    category: 'MILITARY',
    metric: 'STAT',
    meta: { statKey: 'battlesWon' },
    target: 1,
    reward: { GEMS: 10 },
  },
  {
    id: 'ach-town-rising',
    title: 'Town Rising',
    description: 'Reach Town Hall level 5.',
    category: 'PROGRESS',
    metric: 'BUILDING_LEVEL',
    meta: { buildingType: 'TOWN_HALL' },
    target: 5,
    reward: { GEMS: 25 },
  },
  {
    id: 'ach-hoarder',
    title: 'Hoarder',
    description: 'Collect 10,000 resources in total.',
    category: 'ECONOMY',
    metric: 'STAT',
    meta: { statKey: 'resourcesCollected' },
    target: 10_000,
    reward: { GEMS: 15 },
  },
  {
    id: 'ach-warlord',
    title: 'Warlord',
    description: 'Win 50 battles.',
    category: 'MILITARY',
    metric: 'STAT',
    meta: { statKey: 'battlesWon' },
    target: 50,
    reward: { GEMS: 100 },
  },
  {
    id: 'ach-centurion',
    title: 'Centurion',
    description: 'Win 100 battles. A hundred fields, a hundred victories.',
    category: 'MILITARY',
    metric: 'STAT',
    meta: { statKey: 'battlesWon' },
    target: 100,
    reward: { GEMS: 150, XP: 500 },
  },
  {
    id: 'ach-grand-marshal',
    title: 'Grand Marshal',
    description: 'Train 1,000 units. The war machine never sleeps.',
    category: 'MILITARY',
    metric: 'STAT',
    meta: { statKey: 'unitsTrained' },
    target: 1_000,
    reward: { GEMS: 120, XP: 400 },
  },
  {
    id: 'ach-veteran-commander',
    title: 'Veteran Commander',
    description: 'Reach level 10.',
    category: 'PROGRESS',
    metric: 'PLAYER_LEVEL',
    target: 10,
    reward: { GEMS: 40 },
  },
  {
    id: 'ach-season-champion',
    title: 'Season Champion',
    description: 'Finish a season ranked in the top 3.',
    category: 'PROGRESS',
    metric: 'SEASON_TOP',
    meta: { rank: 3 },
    target: 1,
    reward: { GEMS: 250 },
  },
  {
    id: 'ach-season-veteran',
    title: 'Season Veteran',
    description: 'Finish a season ranked in the top 50.',
    category: 'PROGRESS',
    metric: 'SEASON_TOP',
    meta: { rank: 50 },
    target: 1,
    reward: { GEMS: 60 },
  },
]
