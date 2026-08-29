/**
 * WARLORDS — Achievement catalog (baseline).
 * Data source for the `achievements` table seed. Unlocks are evaluated
 * server-side from persisted stats — never from client claims.
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

export interface AchievementCatalogEntry {
  id: string
  title: string
  description: string
  category: AchievementCategory
  target: number
  reward: Partial<Record<RewardKey, number>>
}

export const ACHIEVEMENTS: AchievementCatalogEntry[] = [
  {
    id: 'ach-first-blood',
    title: 'First Blood',
    description: 'Win your first battle.',
    category: 'MILITARY',
    target: 1,
    reward: { GEMS: 10 },
  },
  {
    id: 'ach-town-rising',
    title: 'Town Rising',
    description: 'Reach Town Hall level 5.',
    category: 'PROGRESS',
    target: 5,
    reward: { GEMS: 25 },
  },
  {
    id: 'ach-hoarder',
    title: 'Hoarder',
    description: 'Collect 10,000 gold in total.',
    category: 'ECONOMY',
    target: 10_000,
    reward: { GEMS: 15 },
  },
  {
    id: 'ach-warlord',
    title: 'Warlord',
    description: 'Win 50 battles.',
    category: 'MILITARY',
    target: 50,
    reward: { GEMS: 100 },
  },
]
