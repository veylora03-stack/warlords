/**
 * WARLORDS — Quest catalog (baseline: MAIN chain + DAILY pair).
 * Data source for the `quests` table seed. Objectives are matched by the
 * (future) quest engine against player actions; rewards are granted only
 * by the server on claim (never trusted from the client).
 */

import type { QuestType } from '@/lib/game/types/common'

export const OBJECTIVE_TYPES = [
  'BUILD_UPGRADE',
  'TRAIN_UNITS',
  'COLLECT_RESOURCE',
  'WIN_BATTLES',
  'SPEND_RESOURCE',
  'REACH_POWER',
  'JOIN_CLAN',
  'SCOUT_TARGET',
] as const
export type ObjectiveType = (typeof OBJECTIVE_TYPES)[number]

/** Reward keys understood by the reward-granting service. */
export const REWARD_KEYS = [
  'GOLD',
  'WOOD',
  'IRON',
  'FOOD',
  'CRYSTAL',
  'GEMS',
  'ENERGY',
  'XP',
  'ITEM',
  'COMMANDER',
] as const
export type RewardKey = (typeof REWARD_KEYS)[number]

export interface QuestObjective {
  unitId?: string
  buildingType?: string
  resource?: string
  level?: number
  amount: number
}

export interface QuestCatalogEntry {
  id: string
  type: QuestType
  title: string
  description: string
  objectiveType: ObjectiveType
  objectiveTarget: QuestObjective
  reward: Partial<Record<RewardKey, number>>
  prerequisiteQuestIds: string[]
  repeatable: boolean
  cooldownHours: number
  sortOrder: number
}

export const QUESTS: QuestCatalogEntry[] = [
  {
    id: 'main-01-first-steps',
    type: 'MAIN',
    title: 'First Steps',
    description: 'A keep without a treasury starves its army. Collect 200 gold from production.',
    objectiveType: 'COLLECT_RESOURCE',
    objectiveTarget: { resource: 'GOLD', amount: 200 },
    reward: { GOLD: 100, XP: 50 },
    prerequisiteQuestIds: [],
    repeatable: false,
    cooldownHours: 0,
    sortOrder: 10,
  },
  {
    id: 'main-02-raise-army',
    type: 'MAIN',
    title: 'Raise an Army',
    description: 'Train 10 militia — the countryside is no place for an unarmed keep.',
    objectiveType: 'TRAIN_UNITS',
    objectiveTarget: { unitId: 'militia', amount: 10 },
    reward: { GOLD: 150, XP: 80 },
    prerequisiteQuestIds: ['main-01-first-steps'],
    repeatable: false,
    cooldownHours: 0,
    sortOrder: 20,
  },
  {
    id: 'main-03-homes-teeth',
    type: 'MAIN',
    title: 'Give Your Home Teeth',
    description: 'Raise the Town Hall to level 2 to unlock the next stage of your campaign.',
    objectiveType: 'BUILD_UPGRADE',
    objectiveTarget: { buildingType: 'TOWN_HALL', level: 2, amount: 1 },
    reward: { GOLD: 250, WOOD: 150, XP: 120 },
    prerequisiteQuestIds: ['main-02-raise-army'],
    repeatable: false,
    cooldownHours: 0,
    sortOrder: 30,
  },
  {
    id: 'daily-gold-tribute',
    type: 'DAILY',
    title: 'Gold Tribute',
    description: 'Collect 500 gold in a single day to keep the war chest full.',
    objectiveType: 'COLLECT_RESOURCE',
    objectiveTarget: { resource: 'GOLD', amount: 500 },
    reward: { GEMS: 5, XP: 40 },
    prerequisiteQuestIds: [],
    repeatable: true,
    cooldownHours: 20,
    sortOrder: 100,
  },
  {
    id: 'daily-blood-and-steel',
    type: 'DAILY',
    title: 'Blood and Steel',
    description: 'Win any battle today. Glory keeps the ranks loyal.',
    objectiveType: 'WIN_BATTLES',
    objectiveTarget: { amount: 1 },
    reward: { GEMS: 8, XP: 60 },
    prerequisiteQuestIds: [],
    repeatable: true,
    cooldownHours: 20,
    sortOrder: 110,
  },
]
