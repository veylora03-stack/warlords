/**
 * WARLORDS — Unit catalog (Phase 7: Army & Unit System — the definitive roster).
 *
 * This file is the DATA SOURCE for the `units` table seed. Balance lives here,
 * never in logic (data-driven principle). Combat counters follow the classic
 * triangle from docs/BATTLE_MODEL.md — Infantry ▸ Cavalry ▸ Ranged ▸ Infantry —
 * expressed PER UNIT in `strongAgainst`/`weakAgainst` (uniform 2500 bps edges);
 * siege engines have no field counters and fear only fast cavalry.
 *
 * Every unit declares its TRAINING BUILDING and the level that building must
 * have reached — evaluated SERVER-SIDE against real DB rows at recruit time.
 *
 * All bonuses are basis points (2500 bps = +25%).
 * Roster (Phase 7 contract — 11 units):
 *   Infantry  → Swordsman · Shield Guard · Heavy Infantry   (Barracks)
 *   Ranged    → Archer · Crossbowman                        (Archer Camp)
 *   Cavalry   → Cavalry · Heavy Cavalry · Knight            (Stable)
 *   Siege     → Catapult · Cannon · Siege Engine            (Armory)
 */

import type { BuildingType, UnitClass } from '@/lib/game/types/common'

export interface UnitCounter {
  unitId: string
  bonusBps: number
}

export type UnitPenalty = {
  unitId: string
  penaltyBps: number
}

export interface UnitCatalogEntry {
  id: string
  name: string
  class: UnitClass
  tier: number
  attack: number
  defense: number
  health: number
  speed: number
  /** Food consumed per hour per unit (upkeep). */
  foodUpkeep: number
  /** Loot capacity. */
  carryCapacity: number
  trainingCost: Partial<Record<'GOLD' | 'WOOD' | 'IRON' | 'FOOD' | 'CRYSTAL', number>>
  trainingTimeSec: number
  /** Building type that trains this unit. */
  trainingBuilding: BuildingType
  /** Minimum level the training building must have reached (server-evaluated). */
  requiredBuildingLevel: number
  strongAgainst: UnitCounter[]
  weakAgainst: UnitPenalty[]
  description: string
}

// ── Counter vocabulary (data-driven triangle — 2500 bps edges) ───────────────

const INFANTRY_IDS = ['swordsman', 'shield_guard', 'heavy_infantry'] as const
const RANGED_IDS = ['archer', 'crossbowman'] as const
const CAVALRY_IDS = ['cavalry', 'heavy_cavalry', 'knight'] as const

const COUNTER_BPS = 2500

/** strong vs `ids` — the class triangle edges, per unit. */
function strongVs(ids: readonly string[]): UnitCounter[] {
  return ids.map((unitId) => ({ unitId, bonusBps: COUNTER_BPS }))
}

/** weak vs `ids` — the inverse edges, per unit (symmetric matrix). */
function weakVs(ids: readonly string[]): UnitPenalty[] {
  return ids.map((unitId) => ({ unitId, penaltyBps: COUNTER_BPS }))
}

export const UNITS: UnitCatalogEntry[] = [
  // ── INFANTRY — trained at the Barracks ──────────────────────────────────────
  {
    id: 'swordsman',
    name: 'Swordsman',
    class: 'INFANTRY',
    tier: 1,
    attack: 24,
    defense: 32,
    health: 160,
    speed: 5,
    foodUpkeep: 2,
    carryCapacity: 35,
    trainingCost: { GOLD: 120, FOOD: 60, IRON: 50 },
    trainingTimeSec: 22,
    trainingBuilding: 'BARRACKS',
    requiredBuildingLevel: 1,
    strongAgainst: strongVs(CAVALRY_IDS),
    weakAgainst: weakVs(RANGED_IDS),
    description:
      'Professional infantry — an armored wall that walks, and the bane of cavalry charges.',
  },
  {
    id: 'shield_guard',
    name: 'Shield Guard',
    class: 'INFANTRY',
    tier: 2,
    attack: 18,
    defense: 60,
    health: 240,
    speed: 4,
    foodUpkeep: 3,
    carryCapacity: 25,
    trainingCost: { GOLD: 200, FOOD: 90, IRON: 120, WOOD: 40 },
    trainingTimeSec: 35,
    trainingBuilding: 'BARRACKS',
    requiredBuildingLevel: 5,
    strongAgainst: strongVs(CAVALRY_IDS),
    weakAgainst: weakVs(RANGED_IDS),
    description: 'Tower-shield veterans who hold the line so the line can hold.',
  },
  {
    id: 'heavy_infantry',
    name: 'Heavy Infantry',
    class: 'INFANTRY',
    tier: 3,
    attack: 42,
    defense: 56,
    health: 320,
    speed: 4,
    foodUpkeep: 4,
    carryCapacity: 40,
    trainingCost: { GOLD: 350, FOOD: 140, IRON: 220, CRYSTAL: 5 },
    trainingTimeSec: 55,
    trainingBuilding: 'BARRACKS',
    requiredBuildingLevel: 10,
    strongAgainst: strongVs(CAVALRY_IDS),
    weakAgainst: weakVs(RANGED_IDS),
    description: 'Elite plate-clad footmen — the hammer that breaks a siege line.',
  },

  // ── RANGED — trained at the Archer Camp ─────────────────────────────────────
  {
    id: 'archer',
    name: 'Archer',
    class: 'RANGED',
    tier: 1,
    attack: 15,
    defense: 8,
    health: 80,
    speed: 7,
    foodUpkeep: 1,
    carryCapacity: 25,
    trainingCost: { GOLD: 70, FOOD: 30, WOOD: 40 },
    trainingTimeSec: 15,
    trainingBuilding: 'ARCHER_CAMP',
    requiredBuildingLevel: 1,
    strongAgainst: strongVs(INFANTRY_IDS),
    weakAgainst: weakVs(CAVALRY_IDS),
    description: 'Longbow volunteers who shred slow infantry from a distance.',
  },
  {
    id: 'crossbowman',
    name: 'Crossbowman',
    class: 'RANGED',
    tier: 2,
    attack: 30,
    defense: 14,
    health: 100,
    speed: 6,
    foodUpkeep: 2,
    carryCapacity: 30,
    trainingCost: { GOLD: 160, FOOD: 50, WOOD: 110, IRON: 60 },
    trainingTimeSec: 30,
    trainingBuilding: 'ARCHER_CAMP',
    requiredBuildingLevel: 5,
    strongAgainst: strongVs(INFANTRY_IDS),
    weakAgainst: weakVs(CAVALRY_IDS),
    description: 'Armor-piercing bolts that punch through plate and shield alike.',
  },

  // ── CAVALRY — trained at the Stable ─────────────────────────────────────────
  {
    id: 'cavalry',
    name: 'Cavalry',
    class: 'CAVALRY',
    tier: 1,
    attack: 28,
    defense: 18,
    health: 130,
    speed: 12,
    foodUpkeep: 3,
    carryCapacity: 60,
    trainingCost: { GOLD: 150, FOOD: 100, IRON: 30 },
    trainingTimeSec: 25,
    trainingBuilding: 'STABLE',
    requiredBuildingLevel: 1,
    strongAgainst: strongVs(RANGED_IDS),
    weakAgainst: weakVs(INFANTRY_IDS),
    description: 'Swift outriders who ride down archers and carry rich loot home.',
  },
  {
    id: 'heavy_cavalry',
    name: 'Heavy Cavalry',
    class: 'CAVALRY',
    tier: 2,
    attack: 45,
    defense: 38,
    health: 200,
    speed: 10,
    foodUpkeep: 5,
    carryCapacity: 80,
    trainingCost: { GOLD: 300, FOOD: 160, IRON: 120 },
    trainingTimeSec: 45,
    trainingBuilding: 'STABLE',
    requiredBuildingLevel: 5,
    strongAgainst: strongVs(RANGED_IDS),
    weakAgainst: weakVs(INFANTRY_IDS),
    description: 'Armored lancers whose charge turns a ranged line into a rout.',
  },
  {
    id: 'knight',
    name: 'Knight',
    class: 'CAVALRY',
    tier: 3,
    attack: 70,
    defense: 56,
    health: 260,
    speed: 11,
    foodUpkeep: 7,
    carryCapacity: 100,
    trainingCost: { GOLD: 520, FOOD: 260, IRON: 220, CRYSTAL: 8 },
    trainingTimeSec: 70,
    trainingBuilding: 'STABLE',
    requiredBuildingLevel: 10,
    strongAgainst: strongVs(RANGED_IDS),
    weakAgainst: weakVs(INFANTRY_IDS),
    description: 'Sworn blades of the realm — the finest horsemen gold can saddle.',
  },

  // ── SIEGE — trained at the Armory ───────────────────────────────────────────
  {
    id: 'catapult',
    name: 'Catapult',
    class: 'SIEGE',
    tier: 1,
    attack: 60,
    defense: 10,
    health: 90,
    speed: 3,
    foodUpkeep: 4,
    carryCapacity: 0,
    trainingCost: { GOLD: 250, WOOD: 180, IRON: 80 },
    trainingTimeSec: 45,
    trainingBuilding: 'ARMORY',
    requiredBuildingLevel: 1,
    strongAgainst: [],
    weakAgainst: weakVs(CAVALRY_IDS),
    description: 'Siege engine — excels against walls and territory defenses, not field maneuvers.',
  },
  {
    id: 'cannon',
    name: 'Cannon',
    class: 'SIEGE',
    tier: 2,
    attack: 110,
    defense: 15,
    health: 120,
    speed: 2,
    foodUpkeep: 6,
    carryCapacity: 0,
    trainingCost: { GOLD: 480, WOOD: 260, IRON: 200, CRYSTAL: 6 },
    trainingTimeSec: 80,
    trainingBuilding: 'ARMORY',
    requiredBuildingLevel: 5,
    strongAgainst: [],
    weakAgainst: weakVs(CAVALRY_IDS),
    description: 'Black-powder brute force — gates and towers cease to exist.',
  },
  {
    id: 'siege_engine',
    name: 'Siege Engine',
    class: 'SIEGE',
    tier: 3,
    attack: 180,
    defense: 25,
    health: 200,
    speed: 1,
    foodUpkeep: 8,
    carryCapacity: 0,
    trainingCost: { GOLD: 850, WOOD: 420, IRON: 320, CRYSTAL: 15 },
    trainingTimeSec: 120,
    trainingBuilding: 'ARMORY',
    requiredBuildingLevel: 10,
    strongAgainst: [],
    weakAgainst: weakVs(CAVALRY_IDS),
    description: 'A walking fortress-cracker. Slow as a funeral, final as one.',
  },
]

/** Class display order for army views (Infantry ▸ Ranged ▸ Cavalry ▸ Siege). */
export const UNIT_CLASS_ORDER: UnitClass[] = ['INFANTRY', 'RANGED', 'CAVALRY', 'SIEGE']
