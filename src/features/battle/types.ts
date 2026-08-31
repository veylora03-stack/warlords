/**
 * WARLORDS — Battle feature types (mirrors the battle service read models).
 */

export interface CasualtyRow {
  unitId: string
  unitName: string
  count: number
}

export interface AttackResultView {
  battleId: string
  outcome: 'VICTORY' | 'DEFEAT' | 'DRAW'
  result: 'ATTACKER_WIN' | 'DEFENDER_WIN' | 'DRAW'
  opponent: { playerId: string; name: string; level: number }
  roundsCount: number
  seed: number
  configVersion: number
  unguardedCity: boolean
  casualties: { attacker: CasualtyRow[]; defender: CasualtyRow[] }
  survivors: { attacker: CasualtyRow[]; defender: CasualtyRow[] }
  loot: Record<string, string>
  honor: { attackerDelta: number; defenderDelta: number }
  xp: {
    attackerGained: number
    defenderGained: number
    attackerLevel: number
    attackerLevelsGained: number
  }
  seasonPointsAwarded: number
  energySpent: number
  cooldownUntil: string
  replayed?: boolean
}

export interface AttackTargetRow {
  playerId: string
  name: string
  level: number
  power: string
  honor: string
  reputation: string
  lastLoginAt: string
  attackable: boolean
  blockedBy: string[]
}

export interface BattleTargetsView {
  attacker: {
    energy: number
    energyMax: number
    nextRegenAtMs: number | null
    attackCost: number
    cooldownRemainingSec: number
    armyUnits: number
  }
  targets: AttackTargetRow[]
}

export interface BattleHistoryRow {
  battleId: string
  type: string
  result: string
  myRole: 'ATTACKER' | 'DEFENDER'
  outcome: 'VICTORY' | 'DEFEAT' | 'DRAW'
  opponent: { playerId: string; name: string | null }
  attackerPower: string
  defenderPower: string
  roundsCount: number
  loot: Record<string, string> | null
  honorDelta: number
  energySpent: number
  startedAt: string
  endedAt: string | null
}

export interface BattleHistoryView {
  battles: BattleHistoryRow[]
  page: number
  pageSize: number
  total: number
  pages: number
}

export interface BattleRoundView {
  roundNumber: number
  side: string
  unitsCommitted: Array<{ unitTypeId: string; count: number }>
  unitsLost: Array<{ unitTypeId: string; count: number }>
  damageDealt: string
  actions: Array<{
    actorStackId: string
    actorUnitTypeId: string
    targetUnitTypeId: string
    damage: number
    kills: number
    counterMultBps: number
  }>
}

export interface BattleDetailView {
  battleId: string
  type: string
  result: string
  myRole: 'ATTACKER' | 'DEFENDER'
  outcome: 'VICTORY' | 'DEFEAT' | 'DRAW'
  opponent: { playerId: string; name: string | null }
  seed: number
  configVersion: number
  attackerPower: string
  defenderPower: string
  roundsCount: number
  loot: Record<string, string> | null
  honorDelta: number
  energySpent: number
  startedAt: string
  endedAt: string | null
  rounds: BattleRoundView[]
  report: unknown
}
