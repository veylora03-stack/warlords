/**
 * WARLORDS — Quest catalog (Phase 31: Quest + Achievement Engine).
 * Data source for the `quests` table seed. Objectives are matched by the
 * quest engine (quest-events.service) against REAL server-side domain
 * events only — progress is never client-writable. Rewards are granted
 * only by the server on claim through the Economy/Ledger (QUEST_REWARD
 * reason) — never trusted from the client.
 *
 * Objective semantics (progress modes):
 *  - INCREMENT objectives advance by the event payload's delta:
 *      WIN_BATTLES        +1 per battle the player WON (either role)
 *      BUILD_UPGRADE      +1 per finished upgrade (optionally buildingType/level-gated)
 *      TRAIN_UNITS        +trained count (optionally unitId-gated)
 *      EARN_RESOURCE      +credited amount (optionally resource-gated; ledger
 *                         credits from BOOTSTRAP/BATTLE_REWARD/QUEST_REWARD/
 *                         SEASON_REWARD/ACHIEVEMENT_REWARD/refunds — never
 *                         ADMIN_ADJUSTMENT)
 *      SPEND_RESOURCE     +debited amount (optionally resource-gated)
 *  - SET objectives snap progress to the event value (never decreasing):
 *      REACH_POWER        player.power
 *      REACH_LEVEL        player.level
 *
 * Cycle/reset semantics (server UTC clock ONLY):
 *  - MAIN      → permanent single instance (cycle '0')
 *  - DAILY     → one instance per UTC date (cycle 'YYYY-MM-DD')
 *  - WEEKLY    → one instance per ISO week (cycle 'YYYY-Wnn')
 *  - SEASONAL  → one instance per season (cycle = season number), expiresAt
 *                = season.endsAt — unclaimed rewards expire at settlement
 *
 * Phase 32: TERRITORY objectives are LIVE — world.service raises the typed
 * domain events (TERRITORY_CAPTURED / TERRITORY_DEFENDED) inside the capture
 * transaction, and the engine matches CAPTURE_TERRITORIES (INCREMENT),
 * CONTROL_TERRITORIES (SET — simultaneous hold) and DEFEND_TERRITORIES
 * (INCREMENT) against them. Simultaneous-hold is a SET quest objective by
 * design: achievement counters are monotonic and cannot express a snapshot.
 */

import type { QuestType } from '@/lib/game/types/common'

export const OBJECTIVE_TYPES = [
  'BUILD_UPGRADE',
  'TRAIN_UNITS',
  'EARN_RESOURCE',
  'WIN_BATTLES',
  'SPEND_RESOURCE',
  'REACH_POWER',
  'REACH_LEVEL',
  // Reserved extension points — matched by events that do not exist yet:
  'JOIN_CLAN',
  // Phase 32 — territory domain (activated by world.service events):
  'CAPTURE_TERRITORIES',
  'CONTROL_TERRITORIES',
  'DEFEND_TERRITORIES',
  // Phase 33 — march domain (activated by march.service events):
  'SCOUT_TARGET', // was reserved since Phase 2 — consumes MARCH_SCOUTED
  'MARCHES_COMPLETED', // consumes MARCH_COMPLETED
] as const
export type ObjectiveType = (typeof OBJECTIVE_TYPES)[number]

/** How progress advances for an objective type (engine-enforced). */
export const OBJECTIVE_PROGRESS_MODES = {
  WIN_BATTLES: 'INCREMENT',
  BUILD_UPGRADE: 'INCREMENT',
  TRAIN_UNITS: 'INCREMENT',
  EARN_RESOURCE: 'INCREMENT',
  SPEND_RESOURCE: 'INCREMENT',
  REACH_POWER: 'SET',
  REACH_LEVEL: 'SET',
  JOIN_CLAN: 'INCREMENT',
  SCOUT_TARGET: 'INCREMENT',
  CAPTURE_TERRITORIES: 'INCREMENT',
  CONTROL_TERRITORIES: 'SET',
  DEFEND_TERRITORIES: 'INCREMENT',
  MARCHES_COMPLETED: 'INCREMENT',
} as const satisfies Record<ObjectiveType, 'INCREMENT' | 'SET'>
export type ObjectiveProgressMode = (typeof OBJECTIVE_PROGRESS_MODES)[ObjectiveType]

/** Reward keys understood by the reward-granting service (quest claim). */
export const REWARD_KEYS = [
  'GOLD',
  'WOOD',
  'IRON',
  'FOOD',
  'CRYSTAL',
  'GEMS',
  'XP',
  'HONOR',
  'ENERGY',
  'ITEM',
  'COMMANDER',
] as const
export type RewardKey = (typeof REWARD_KEYS)[number]

/** Reward keys the claim pipeline implements today (fail-closed otherwise). */
export const CLAIMABLE_REWARD_KEYS: readonly RewardKey[] = [
  'GOLD',
  'WOOD',
  'IRON',
  'FOOD',
  'CRYSTAL',
  'GEMS',
  'XP',
  'HONOR',
]

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
  minLevel: number
  repeatable: boolean
  cooldownHours: number
  sortOrder: number
}

export const QUESTS: QuestCatalogEntry[] = [
  // ── MAIN chain (permanent, prerequisite-gated) ────────────────────────────
  {
    id: 'main-01-first-steps',
    type: 'MAIN',
    title: 'First Steps',
    description: 'A keep without a treasury starves its army. Accumulate 200 gold.',
    objectiveType: 'EARN_RESOURCE',
    objectiveTarget: { resource: 'GOLD', amount: 200 },
    reward: { GOLD: 100, XP: 50 },
    prerequisiteQuestIds: [],
    minLevel: 0,
    repeatable: false,
    cooldownHours: 0,
    sortOrder: 10,
  },
  {
    id: 'main-02-raise-army',
    type: 'MAIN',
    title: 'Raise an Army',
    description: 'Train 10 swordsmen — the countryside is no place for an unarmed keep.',
    objectiveType: 'TRAIN_UNITS',
    objectiveTarget: { unitId: 'swordsman', amount: 10 },
    reward: { GOLD: 150, XP: 80 },
    prerequisiteQuestIds: ['main-01-first-steps'],
    minLevel: 0,
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
    minLevel: 0,
    repeatable: false,
    cooldownHours: 0,
    sortOrder: 30,
  },
  {
    id: 'main-04-first-battle',
    type: 'MAIN',
    title: 'First Battle',
    description: 'Win your first battle. Glory — and plunder — await the bold.',
    objectiveType: 'WIN_BATTLES',
    objectiveTarget: { amount: 1 },
    reward: { GOLD: 200, XP: 100, HONOR: 10 },
    prerequisiteQuestIds: ['main-03-homes-teeth'],
    minLevel: 0,
    repeatable: false,
    cooldownHours: 0,
    sortOrder: 40,
  },
  {
    id: 'main-05-warlord',
    type: 'MAIN',
    title: 'Warlord',
    description: 'Win 10 battles. Let your name be spoken with fear across the realm.',
    objectiveType: 'WIN_BATTLES',
    objectiveTarget: { amount: 10 },
    reward: { GOLD: 500, XP: 300, HONOR: 50 },
    prerequisiteQuestIds: ['main-04-first-battle'],
    minLevel: 0,
    repeatable: false,
    cooldownHours: 0,
    sortOrder: 50,
  },
  {
    id: 'main-06-first-territory',
    type: 'MAIN',
    title: 'First Banner',
    description: "Capture your first territory. Your banner must fly beyond the keep's walls.",
    objectiveType: 'CAPTURE_TERRITORIES',
    objectiveTarget: { amount: 1 },
    reward: { GOLD: 300, WOOD: 150, XP: 150, HONOR: 20 },
    prerequisiteQuestIds: ['main-05-warlord'],
    minLevel: 0,
    repeatable: false,
    cooldownHours: 0,
    sortOrder: 60,
  },

  // ── DAILY (reset at UTC midnight — server clock only) ─────────────────────
  {
    id: 'daily-gold-tribute',
    type: 'DAILY',
    title: 'Gold Tribute',
    description: 'Accumulate 500 gold in a single day to keep the war chest full.',
    objectiveType: 'EARN_RESOURCE',
    objectiveTarget: { resource: 'GOLD', amount: 500 },
    reward: { GEMS: 5, XP: 40 },
    prerequisiteQuestIds: [],
    minLevel: 0,
    repeatable: true,
    cooldownHours: 0,
    sortOrder: 100,
  },
  {
    id: 'daily-blood-and-steel',
    type: 'DAILY',
    title: 'Blood and Steel',
    description: 'Win 2 battles today. Glory keeps the ranks loyal.',
    objectiveType: 'WIN_BATTLES',
    objectiveTarget: { amount: 2 },
    reward: { GEMS: 8, XP: 60 },
    prerequisiteQuestIds: [],
    minLevel: 0,
    repeatable: true,
    cooldownHours: 0,
    sortOrder: 110,
  },
  {
    id: 'daily-drill-yard',
    type: 'DAILY',
    title: 'Drill Yard',
    description: 'Train 20 units today. An army is forged one recruit at a time.',
    objectiveType: 'TRAIN_UNITS',
    objectiveTarget: { amount: 20 },
    reward: { GEMS: 6, XP: 45 },
    prerequisiteQuestIds: [],
    minLevel: 0,
    repeatable: true,
    cooldownHours: 0,
    sortOrder: 120,
  },

  // ── WEEKLY (reset at UTC Monday 00:00) ────────────────────────────────────
  {
    id: 'weekly-master-builder',
    type: 'WEEKLY',
    title: 'Master Builder',
    description: 'Complete 5 building upgrades this week. Stone and timber win wars too.',
    objectiveType: 'BUILD_UPGRADE',
    objectiveTarget: { amount: 5 },
    reward: { GOLD: 400, GEMS: 15, XP: 150 },
    prerequisiteQuestIds: [],
    minLevel: 0,
    repeatable: true,
    cooldownHours: 0,
    sortOrder: 200,
  },
  {
    id: 'weekly-recruiter',
    type: 'WEEKLY',
    title: 'Recruiter',
    description: 'Train 100 units this week. The muster rolls must be full.',
    objectiveType: 'TRAIN_UNITS',
    objectiveTarget: { amount: 100 },
    reward: { GOLD: 350, GEMS: 12, XP: 120 },
    prerequisiteQuestIds: [],
    minLevel: 0,
    repeatable: true,
    cooldownHours: 0,
    sortOrder: 210,
  },
  {
    id: 'weekly-resource-tycoon',
    type: 'WEEKLY',
    title: 'Resource Tycoon',
    description: 'Accumulate 5,000 gold this week. Wealth funds the war effort.',
    objectiveType: 'EARN_RESOURCE',
    objectiveTarget: { resource: 'GOLD', amount: 5000 },
    reward: { GEMS: 20, XP: 180 },
    prerequisiteQuestIds: [],
    minLevel: 0,
    repeatable: true,
    cooldownHours: 0,
    sortOrder: 220,
  },
  // ── Phase 33 — march domain (weekly rhythm; real march-engine events) ─────
  {
    id: 'weekly-patrol',
    type: 'WEEKLY',
    title: 'Patrol Roads',
    description: 'Complete 5 marches this week. Armies that move, win.',
    objectiveType: 'MARCHES_COMPLETED',
    objectiveTarget: { amount: 5 },
    reward: { GOLD: 400, GEMS: 12, XP: 140 },
    prerequisiteQuestIds: [],
    minLevel: 0,
    repeatable: true,
    cooldownHours: 0,
    sortOrder: 230,
  },
  {
    id: 'weekly-recon',
    type: 'WEEKLY',
    title: 'Eyes on the Roads',
    description: 'Scout 3 territories this week. Knowledge is a weapon.',
    objectiveType: 'SCOUT_TARGET',
    objectiveTarget: { amount: 3 },
    reward: { GOLD: 300, GEMS: 10, XP: 120 },
    prerequisiteQuestIds: [],
    minLevel: 0,
    repeatable: true,
    cooldownHours: 0,
    sortOrder: 240,
  },

  // ── SEASONAL (reset at season settlement; rewards expire with the season) ─
  {
    id: 'seasonal-conqueror',
    type: 'SEASONAL',
    title: 'Conqueror',
    description: 'Capture 3 territories this season. The map remembers the bold.',
    objectiveType: 'CAPTURE_TERRITORIES',
    objectiveTarget: { amount: 3 },
    reward: { GOLD: 800, GEMS: 25, XP: 250, HONOR: 40 },
    prerequisiteQuestIds: [],
    minLevel: 0,
    repeatable: true,
    cooldownHours: 0,
    sortOrder: 300,
  },
  {
    id: 'seasonal-land-lord',
    type: 'SEASONAL',
    title: 'Land Lord',
    description: 'Hold 5 territories at the same time this season.',
    objectiveType: 'CONTROL_TERRITORIES',
    objectiveTarget: { amount: 5 },
    reward: { GOLD: 1000, CRYSTAL: 10, GEMS: 30, XP: 300 },
    prerequisiteQuestIds: [],
    minLevel: 0,
    repeatable: true,
    cooldownHours: 0,
    sortOrder: 310,
  },
  {
    id: 'seasonal-defender',
    type: 'SEASONAL',
    title: 'Shield of the Realm',
    description: 'Successfully defend your territories 5 times this season.',
    objectiveType: 'DEFEND_TERRITORIES',
    objectiveTarget: { amount: 5 },
    reward: { GOLD: 600, GEMS: 20, XP: 200, HONOR: 30 },
    prerequisiteQuestIds: [],
    minLevel: 0,
    repeatable: true,
    cooldownHours: 0,
    sortOrder: 320,
  },
]

/**
 * Quest types with PERIODIC cycles (re-assigned per period). MAIN and other
 * permanent types use cycle '0' — assigned once, never reset by the clock.
 */
export const CYCLIC_QUEST_TYPES: readonly QuestType[] = ['DAILY', 'WEEKLY', 'SEASONAL']
