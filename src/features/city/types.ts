/**
 * WARLORDS — City feature types (mirror of the server DTOs).
 *
 * All amounts cross the API as strings (BigInt policy) — the UI performs
 * display formatting only, never authority math. Construction timers are
 * rendered from server timestamps; the server clock stays the only timing
 * authority (the local countdown is cosmetic).
 */

export interface CityProduction {
  GOLD: number
  WOOD: number
  IRON: number
  FOOD: number
}

export type ConstructionStatus = 'IDLE' | 'CONSTRUCTING' | 'COMPLETABLE'

export interface BuildingNextUpgrade {
  toLevel: number
  cost: Partial<Record<string, string>>
  durationSec: number
  requirements: {
    townHallLevel?: number
    playerLevel?: number
    buildings?: Record<string, number>
  }
  requirementsMet: boolean
  unmetRequirements: string[]
}

export interface CityBuildingView {
  id: string
  type: string
  name: string
  category: string
  level: number
  maxLevel: number
  status: ConstructionStatus
  isConstructing: boolean
  upgradeStartedAt: string | null
  upgradeCompletesAt: string | null
  pendingLevel: number | null
  effects: Record<string, unknown>
  nextUpgrade: BuildingNextUpgrade | null
}

export interface CityView {
  city: { id: string; name: string; x: number; y: number }
  buildings: CityBuildingView[]
  production: CityProduction
  storage: { capacity: number }
  construction: { activeCount: number; queueSlots: number }
  updatedAt: string
}

export interface BuildingUpgradeResult {
  building: CityBuildingView
  balances: Record<string, string>
}

export interface BuildingFinishResult {
  building: CityBuildingView
  power: number
  newLevel: number
}

export interface BuildingLevelSpec {
  level: number
  cost: Partial<Record<string, string>>
  durationSec: number
  requirements: BuildingNextUpgrade['requirements']
  effects: Record<string, unknown>
}

export interface BuildingCatalogEntry {
  type: string
  name: string
  category: string
  description: string
  maxLevel: number
  levels: BuildingLevelSpec[]
}

export interface BuildingCatalogView {
  types: BuildingCatalogEntry[]
}

/** Display metadata per building type (icon glyph). */
export const BUILDING_ICONS: Record<string, string> = {
  TOWN_HALL: '🏛️',
  CASTLE: '🏰',
  BARRACKS: '⚔️',
  ARCHER_CAMP: '🏹',
  STABLE: '🐎',
  ARMORY: '🛡️',
  HOSPITAL: '⛺',
  FARM: '🌾',
  WOOD_MILL: '🪵',
  IRON_MINE: '⛏️',
  GOLD_MINE: '💰',
  ACADEMY: '📚',
  SCOUT_CENTER: '🔭',
  SPY_CENTER: '🕵️',
  WAREHOUSE: '📦',
  MARKET: '⚖️',
  WALL: '🧱',
}
