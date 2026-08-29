/**
 * WARLORDS — Technology catalog (baseline Tier 1–2).
 * Data source for the `technologies` table seed. Effects are basis points
 * per level; costs are absolute resource amounts per level.
 */

import type { TechBranch } from '@/lib/game/types/common'

export interface TechCost {
  GOLD?: number
  WOOD?: number
  IRON?: number
  FOOD?: number
  CRYSTAL?: number
}

export interface TechnologyCatalogEntry {
  id: string
  name: string
  branch: TechBranch
  tier: number
  maxLevel: number
  prerequisites: Array<{ technologyId: string; level: number }>
  costPerLevel: TechCost
  effectsPerLevel: Record<string, number> // effect key → bps per level
  researchTimeSecPerLevel: number
  description: string
}

export const TECHNOLOGIES: TechnologyCatalogEntry[] = [
  {
    id: 'iron_sharpening',
    name: 'Iron Sharpening',
    branch: 'MILITARY',
    tier: 1,
    maxLevel: 5,
    prerequisites: [],
    costPerLevel: { GOLD: 200, IRON: 100 },
    effectsPerLevel: { attackBps: 300 },
    researchTimeSecPerLevel: 60,
    description: 'Better whetstones, sharper blades: +3% troop attack per level.',
  },
  {
    id: 'logging',
    name: 'Mechanized Logging',
    branch: 'ECONOMY',
    tier: 1,
    maxLevel: 5,
    prerequisites: [],
    costPerLevel: { GOLD: 150, WOOD: 120 },
    effectsPerLevel: { woodProductionBps: 400 },
    researchTimeSecPerLevel: 50,
    description: 'Two-man saws and ox teams: +4% wood production per level.',
  },
  {
    id: 'fortification',
    name: 'Fortification',
    branch: 'DEFENSE',
    tier: 1,
    maxLevel: 5,
    prerequisites: [],
    costPerLevel: { GOLD: 250, WOOD: 150, IRON: 120 },
    effectsPerLevel: { wallDefenseBps: 350 },
    researchTimeSecPerLevel: 70,
    description: 'Angular bastions and deeper ditches: +3.5% wall defense per level.',
  },
  {
    id: 'advanced_steel',
    name: 'Advanced Steel',
    branch: 'MILITARY',
    tier: 2,
    maxLevel: 3,
    prerequisites: [{ technologyId: 'iron_sharpening', level: 3 }],
    costPerLevel: { GOLD: 600, IRON: 350, CRYSTAL: 5 },
    effectsPerLevel: { attackBps: 500, defenseBps: 200 },
    researchTimeSecPerLevel: 180,
    description: 'Crucible steel for elite formations: +5% attack, +2% defense per level.',
  },
]
