/**
 * WARLORDS — Player feature types (mirrors the server DTOs exactly).
 *
 * BigInt policy: amounts arrive as strings from the API (xp, power, honor,
 * wallet) — the client treats them as opaque display values, never does
 * float math on them.
 */

export interface PlayerProfile {
  id: string
  name: string
  userId: string
  level: number
  xp: string
  xpIntoLevel: number
  xpForNextLevel: number
  levelProgressBps: number
  power: string
  powerBreakdown: { units: number; buildings: number; technologies: number }
  honor: string
  reputation: string
  reputationScore: number
  energy: number
  energyMax: number
  energyNextRegenAtMs: number | null
  gems: string
  seasonPoints: number
  city: { id: string; name: string; x: number; y: number } | null
  clan: { id: string; role: string } | null
  createdAt: string
}

export interface PlayerStatistics {
  playerId: string
  statistics: Record<string, number>
}

export interface PlayerState {
  profile: PlayerProfile
  wallet: { gold: string; wood: string; iron: string; food: string; crystal: string }
  army: Array<{ unitId: string; name: string; class: string; tier: number; count: number }>
  buildingCount: number
}
