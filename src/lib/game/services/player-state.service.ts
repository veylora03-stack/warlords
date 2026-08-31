/**
 * WARLORDS — Player state projections (read side of the Player System).
 *
 * Assembles the server-owned view of a player for the Profile API:
 *   - getPlayerProfile    → identity + progression + honor/reputation +
 *                           freshly computed power + lazy-synced energy
 *   - getPlayerStatistics → the typed counter record (config/stats.ts)
 *   - getPlayerState      → the full Mini App bootstrap payload (profile +
 *                           wallet + city + buildings + army)
 *
 * Rules:
 *  - Power is COMPUTED FRESH on every projection from real state — the
 *    stored column is only a cache written by recalculatePlayerPower.
 *  - Energy is lazily regenerated (lazy-tick model) before projection.
 *  - Every BigInt (xp, power, honor, wallet amounts) crosses the API as a
 *    string — clients do display math only, never float math.
 *  - Projection reads NEVER accept client input beyond the authenticated
 *    player id (requirePlayer in the route layer).
 */

import { db } from '@/lib/db'
import type { Tx } from './player-bootstrap.service'
import { AppError } from '@/lib/api/errors'
import { readLevelProgress } from './progression.service'
import { computePowerFromRows } from './power.service'
import { computeEnergyState, ENERGY } from '@/lib/game/config/energy'
import { normalizeStoredStats, type PlayerStats } from './stats.service'

type ReadClient = Tx | typeof db

// ── DTOs (BigInt fields pre-serialized to strings) ───────────────────────────

export interface PlayerProfileDto {
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

export interface PlayerStatisticsDto {
  playerId: string
  statistics: PlayerStats
}

export interface PlayerStateDto {
  profile: PlayerProfileDto
  wallet: { gold: string; wood: string; iron: string; food: string; crystal: string }
  army: Array<{
    unitId: string
    name: string
    class: string
    tier: number
    count: number
  }>
  buildingCount: number
}

// ── Internals ────────────────────────────────────────────────────────────────

async function loadPlayer(client: ReadClient, playerId: string) {
  const player = await client.player.findUnique({
    where: { id: playerId },
    include: {
      wallet: true,
      city: { select: { id: true, name: true, x: true, y: true } },
    },
  })
  if (!player) throw new AppError('PLAYER_NOT_FOUND', 'Player not found')
  return player
}

/** Shared core: energy sync → fresh power → progression → profile DTO.
 *  Phase 25: energy resolves from the ALREADY-loaded row (a write only when
 *  a regen tick elapsed) and power aggregates via the pure row helper —
 *  same outputs, two fewer round-trips than before. */
async function buildProfile(client: ReadClient, playerId: string): Promise<PlayerProfileDto> {
  const player = await loadPlayer(client, playerId)

  // Lazy-tick: energy advances to "now" before it is projected.
  const energy = computeEnergyState(
    { energy: player.energy, energyUpdatedAt: player.energyUpdatedAt },
    new Date(),
  )
  if (energy.changed) {
    await client.player.update({
      where: { id: playerId },
      data: { energy: energy.energy, energyUpdatedAt: energy.energyUpdatedAt },
    })
  }

  // Power is recomputed from the player's REAL state on every read.
  const [stacks, buildings, techs] = await Promise.all([
    client.playerUnit.findMany({
      where: { playerId },
      select: {
        count: true,
        unit: { select: { attack: true, defense: true, health: true, tier: true } },
      },
    }),
    client.building.findMany({
      where: { city: { playerId } },
      select: { type: true, level: true },
    }),
    client.playerTechnology.findMany({
      where: { playerId },
      select: { level: true, technology: { select: { branch: true } } },
    }),
  ])
  const power = computePowerFromRows(stacks, buildings, techs)
  const progression = readLevelProgress(player.xp)

  return {
    id: player.id,
    name: player.name,
    userId: player.userId,
    level: progression.level,
    xp: player.xp.toString(),
    xpIntoLevel: progression.xpIntoLevel,
    xpForNextLevel: progression.xpForNextLevel,
    levelProgressBps: progression.progressBps,
    power: power.total.toString(),
    powerBreakdown: {
      units: power.units,
      buildings: power.buildings,
      technologies: power.technologies,
    },
    honor: player.honor.toString(),
    reputation: player.reputation,
    reputationScore: player.reputationScore,
    energy: energy.energy,
    energyMax: ENERGY.max,
    energyNextRegenAtMs: energy.nextRegenAtMs,
    gems: player.gems.toString(),
    seasonPoints: player.seasonPoints,
    city: player.city,
    clan: player.clanId ? { id: player.clanId, role: player.clanRole ?? 'MEMBER' } : null,
    createdAt: player.createdAt.toISOString(),
  }
}

// ── Public projections ───────────────────────────────────────────────────────

export async function getPlayerProfile(
  client: ReadClient,
  playerId: string,
): Promise<PlayerProfileDto> {
  return buildProfile(client, playerId)
}

export async function getPlayerStatistics(
  client: ReadClient,
  playerId: string,
): Promise<PlayerStatisticsDto> {
  // Confirms existence with a typed 404 before returning counters.
  const player = await client.player.findUnique({
    where: { id: playerId },
    select: { stats: true },
  })
  if (!player) throw new AppError('PLAYER_NOT_FOUND', 'Player not found')
  return { playerId, statistics: normalizeStoredStats(player.stats) }
}

export async function getPlayerState(
  client: ReadClient,
  playerId: string,
): Promise<PlayerStateDto> {
  // Phase 25: ONE parallel read round (4 queries) instead of 14 overlapping
  // ones. The state payload is the Mini App bootstrap read and the hottest
  // endpoint under load — player, wallet, city, energy, stats, power inputs
  // and the army all come from the SAME rows (measured: 17 → 7 queries).
  const [player, army, buildings, techs] = await Promise.all([
    client.player.findUnique({
      where: { id: playerId },
      include: {
        wallet: true,
        city: { select: { id: true, name: true, x: true, y: true } },
      },
    }),
    client.playerUnit.findMany({
      where: { playerId },
      select: {
        count: true,
        unit: {
          select: {
            id: true,
            name: true,
            class: true,
            tier: true,
            attack: true,
            defense: true,
            health: true,
          },
        },
      },
      orderBy: [{ unit: { tier: 'asc' } }, { unit: { id: 'asc' } }],
    }),
    client.building.findMany({
      where: { city: { playerId } },
      select: { type: true, level: true },
    }),
    client.playerTechnology.findMany({
      where: { playerId },
      select: { level: true, technology: { select: { branch: true } } },
    }),
  ])

  if (!player) throw new AppError('PLAYER_NOT_FOUND', 'Player not found')
  if (!player.wallet) {
    // Ledger-first invariant: a player without a wallet is a bootstrap bug.
    throw new AppError('INTERNAL_ERROR', 'Player wallet is missing')
  }

  // Lazy energy tick — resolved from the ALREADY-loaded row; a write is
  // issued only when a regeneration tick actually elapsed (identical
  // semantics to syncPlayerEnergy, minus its redundant SELECT).
  const energy = computeEnergyState(
    { energy: player.energy, energyUpdatedAt: player.energyUpdatedAt },
    new Date(),
  )
  if (energy.changed) {
    await client.player.update({
      where: { id: playerId },
      data: { energy: energy.energy, energyUpdatedAt: energy.energyUpdatedAt },
    })
  }

  const power = computePowerFromRows(army, buildings, techs)
  const progression = readLevelProgress(player.xp)

  return {
    profile: {
      id: player.id,
      name: player.name,
      userId: player.userId,
      level: progression.level,
      xp: player.xp.toString(),
      xpIntoLevel: progression.xpIntoLevel,
      xpForNextLevel: progression.xpForNextLevel,
      levelProgressBps: progression.progressBps,
      power: power.total.toString(),
      powerBreakdown: {
        units: power.units,
        buildings: power.buildings,
        technologies: power.technologies,
      },
      honor: player.honor.toString(),
      reputation: player.reputation,
      reputationScore: player.reputationScore,
      energy: energy.energy,
      energyMax: ENERGY.max,
      energyNextRegenAtMs: energy.nextRegenAtMs,
      gems: player.gems.toString(),
      seasonPoints: player.seasonPoints,
      city: player.city,
      clan: player.clanId ? { id: player.clanId, role: player.clanRole ?? 'MEMBER' } : null,
      createdAt: player.createdAt.toISOString(),
    },
    wallet: {
      gold: player.wallet.gold.toString(),
      wood: player.wallet.wood.toString(),
      iron: player.wallet.iron.toString(),
      food: player.wallet.food.toString(),
      crystal: player.wallet.crystal.toString(),
    },
    army: army.map((row) => ({
      unitId: row.unit.id,
      name: row.unit.name,
      class: row.unit.class,
      tier: row.unit.tier,
      count: row.count,
    })),
    buildingCount: buildings.length,
  }
}
