/**
 * WARLORDS — Unit catalog (baseline Tier 1–2 roster).
 *
 * This file is the DATA SOURCE for the `units` table seed. Balance lives here,
 * never in logic (data-driven principle). Combat counters follow the classic
 * triangle from docs/BATTLE_MODEL.md: Infantry ▸ Cavalry ▸ Ranged ▸ Infantry;
 * Siege counters fortifications rather than field units.
 *
 * All bonuses are basis points (2500 bps = +25%).
 */

import type { UnitClass } from '@/lib/game/types/common'

export interface UnitCounter {
  unitId: string
  bonusBps: number
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
  foodUpkeep: number
  carryCapacity: number
  trainingCost: Partial<Record<'GOLD' | 'WOOD' | 'IRON' | 'FOOD' | 'CRYSTAL', number>>
  trainingTimeSec: number
  strongAgainst: UnitCounter[]
  description: string
}

export const UNITS: UnitCatalogEntry[] = [
  {
    id: 'militia',
    name: 'Militia',
    class: 'INFANTRY',
    tier: 1,
    attack: 10,
    defense: 15,
    health: 100,
    speed: 6,
    foodUpkeep: 1,
    carryCapacity: 20,
    trainingCost: { GOLD: 50, FOOD: 40 },
    trainingTimeSec: 12,
    strongAgainst: [
      { unitId: 'scout', bonusBps: 2500 },
      { unitId: 'light_cavalry', bonusBps: 2500 },
    ],
    description: 'Levy spearmen — cheap, sturdy, and the bane of cavalry charges.',
  },
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
    strongAgainst: [
      { unitId: 'militia', bonusBps: 2500 },
      { unitId: 'swordsman', bonusBps: 2500 },
    ],
    description: 'Longbow volunteers who shred slow infantry from a distance.',
  },
  {
    id: 'scout',
    name: 'Scout',
    class: 'CAVALRY',
    tier: 1,
    attack: 5,
    defense: 5,
    health: 70,
    speed: 14,
    foodUpkeep: 2,
    carryCapacity: 10,
    trainingCost: { GOLD: 60, FOOD: 60 },
    trainingTimeSec: 10,
    strongAgainst: [{ unitId: 'archer', bonusBps: 2000 }],
    description: 'Fast riders for reconnaissance. Fights only when cornered.',
  },
  {
    id: 'swordsman',
    name: 'Swordsman',
    class: 'INFANTRY',
    tier: 2,
    attack: 24,
    defense: 32,
    health: 160,
    speed: 5,
    foodUpkeep: 2,
    carryCapacity: 35,
    trainingCost: { GOLD: 120, FOOD: 60, IRON: 50 },
    trainingTimeSec: 22,
    strongAgainst: [
      { unitId: 'scout', bonusBps: 2500 },
      { unitId: 'light_cavalry', bonusBps: 2500 },
    ],
    description: 'Professional infantry — an armored wall that walks.',
  },
  {
    id: 'light_cavalry',
    name: 'Light Cavalry',
    class: 'CAVALRY',
    tier: 2,
    attack: 28,
    defense: 18,
    health: 130,
    speed: 12,
    foodUpkeep: 3,
    carryCapacity: 60,
    trainingCost: { GOLD: 150, FOOD: 100, IRON: 30 },
    trainingTimeSec: 25,
    strongAgainst: [{ unitId: 'archer', bonusBps: 2500 }],
    description: 'Swift outriders who ride down archers and carry rich loot home.',
  },
  {
    id: 'catapult',
    name: 'Catapult',
    class: 'SIEGE',
    tier: 2,
    attack: 60,
    defense: 10,
    health: 90,
    speed: 3,
    foodUpkeep: 4,
    carryCapacity: 0,
    trainingCost: { GOLD: 250, WOOD: 180, IRON: 80 },
    trainingTimeSec: 45,
    strongAgainst: [],
    description: 'Siege engine — excels against walls and territory defenses, not field maneuvers.',
  },
]
