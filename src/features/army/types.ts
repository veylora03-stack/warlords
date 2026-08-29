/**
 * WARLORDS — Army feature types (mirror of the server DTOs).
 *
 * All amounts cross the API as strings (BigInt policy) — the UI performs
 * display formatting only, never authority math. Training timers are
 * rendered from server timestamps; the server clock stays the only timing
 * authority (the local countdown is cosmetic).
 */

export type QueueItemStatus = 'TRAINING' | 'COMPLETABLE' | 'DONE' | 'CANCELLED'

export interface TrainingQueueItemView {
  id: string
  unitId: string
  unitName: string
  count: number
  status: QueueItemStatus
  startedAt: string
  completesAt: string
  remainingSec: number
}

export interface ArmyUnitStackView {
  unitId: string
  name: string
  class: string
  tier: number
  count: number
  attack: number
  defense: number
  health: number
  speed: number
  foodUpkeep: number
  carryCapacity: number
}

export interface ArmyView {
  units: ArmyUnitStackView[]
  totals: {
    unitCount: number
    upkeepFood: number
    carryCapacity: number
  }
  training: {
    queue: TrainingQueueItemView[]
    activeCount: number
    queueSlots: number
    speedBps: Partial<Record<string, number>>
  }
  updatedAt: string
}

export interface RecruitResult {
  item: TrainingQueueItemView
  queue: TrainingQueueItemView[]
  balances: Record<string, string>
}

export interface TrainingCompleteResult {
  completed: { id: string; unitId: string; unitName: string; count: number }
  power: number
  /** The player's total count of THE trained unit (starter + trained). */
  stackCount: number
  queue: TrainingQueueItemView[]
}

export interface TrainingCancelResult {
  cancelled: {
    id: string
    unitId: string
    unitName: string
    count: number
    wasStarted: boolean
    refundBps: number
  }
  refund: Partial<Record<string, string>>
  balances: Record<string, string>
  queue: TrainingQueueItemView[]
}

export interface CatalogUnitView {
  id: string
  name: string
  class: string
  tier: number
  attack: number
  defense: number
  health: number
  speed: number
  foodUpkeep: number
  carryCapacity: number
  trainingCost: Partial<Record<string, string>>
  trainingTimeSec: number
  trainingBuilding: string
  trainingBuildingName: string
  requiredBuildingLevel: number
  strongAgainst: Array<{ unitId: string; bonusBps: number }>
  weakAgainst: Array<{ unitId: string; penaltyBps: number }>
  description: string
}

export interface ArmyCatalogView {
  units: CatalogUnitView[]
}

/** Display metadata per unit class (icon glyph). */
export const UNIT_CLASS_ICONS: Record<string, string> = {
  INFANTRY: '🗡️',
  RANGED: '🏹',
  CAVALRY: '🐎',
  SIEGE: '🎯',
}

export const UNIT_CLASS_LABELS: Record<string, string> = {
  INFANTRY: 'Infantry',
  RANGED: 'Ranged',
  CAVALRY: 'Cavalry',
  SIEGE: 'Siege',
}
