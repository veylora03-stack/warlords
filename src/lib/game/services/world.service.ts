/**
 * WARLORDS — World service (Phase 32: World Map + Territory Engine).
 *
 * THE single server-side write path for territory ownership and production.
 * The client supplies ONLY a territory id (and an optional idempotency key) —
 * terrain, adjacency, ownership, garrisons, seeds, casualties, spoils,
 * capture results, rewards and cooldowns are resolved from server state and
 * the data-driven world/battle configs (NEVER TRUST THE CLIENT).
 *
 * Combat reuses the EXISTING battle engine end-to-end — no second simulator:
 *
 *   request → idempotency fast-path → runWorldBattleTransaction:
 *     ensure world generated (idempotent, once)
 *     → validate territory / season / ownership / adjacency / cooldown
 *     → sync + spend energy (CAS)
 *     → load attacker army (REAL rows) + resolve defender:
 *         · player-owned  → the owner's REAL army + terrain defense modifier
 *         · unclaimed     → deterministic VIRTUAL garrison (documented NPC)
 *     → simulateBattle({ type: TERRITORY_ASSAULT, terrain })   ← PURE
 *     → apply: battle row · rounds · unit CAS decrements · spoils ledger
 *              honor · XP (grantXp) · season points · stats · power
 *              territory capture (conditional) · history row · quest events
 *              · achievements · battle logs · outbox notifications
 *     → idempotency claim (same tx)
 *   → response
 *
 * Concurrency: assaults run behind the SAME `battle:engine` → `db:write`
 * lock order as city raids — a territory battle cannot interleave with any
 * other combat, training or construction; two simultaneous attacks on one
 * territory are fully serial. Capture is additionally guarded by a
 * conditional updateMany (owner never flips twice).
 *
 * Territory history is APPEND-ONLY and records every ownership transition
 * (SPAWN · CAPTURE · SEASON_RESET · ADMIN) inside the causing transaction.
 */

import { Prisma } from '@prisma/client'
import { createHash, randomInt } from 'node:crypto'
import { db, dbWrite } from '@/lib/db'
import { AppError } from '@/lib/api/errors'
import { logger } from '@/lib/logger'
import { withKeyLock } from '@/lib/concurrency/mutex'
import { withWriteRetry } from './player-registration.service'
import type { Tx } from './player-bootstrap.service'
import {
  battleConfigSnapshot,
  loadArmySide,
  casualtyRows,
  type CasualtyRow,
} from './battle.service'
import { simulateBattle } from '@/lib/game/engine/battle/simulator'
import type { BattleSimulationResult } from '@/lib/game/types/battle'
import {
  adjacentCoords,
  accruedProduction,
  generateWorld,
  garrisonFor,
  type GarrisonCatalogRow,
} from '@/lib/game/engine/world/generator'
import {
  TERRAIN,
  WORLD,
  WORLD_ADMIN,
  WORLD_ATTACK,
  WORLD_GARRISON,
  WORLD_MAP_POLICY,
  WORLD_PRODUCTION,
  type TerritoryStatus,
} from '@/lib/game/config/world'
import { BATTLE } from '@/lib/game/config/battle'
import type { TerrainType, BattleSide } from '@/lib/game/types/battle'
import { EMPTY_BPS, type BpsModifiers, type LootResource } from '@/lib/game/types/battle'
import type { BattleResult } from '@/lib/game/types/common'
import type { EconomyResource } from '@/lib/game/config/economy'
import { ECONOMY_TX_OPTIONS, grantResources, runEconomyTransaction } from './economy.service'
import { syncPlayerEnergy } from './energy.service'
import { recalculatePlayerPower } from './power.service'
import { grantXp, type GrantXpResult } from './progression.service'
import { awardSeasonPointsInTx, resolveSeasonStateInTx } from './season.service'
import { resolveSeasonState } from './season-state.service'
import { recordPlayerStats } from './stats.service'
import { applyQuestEventInTx } from './quest-events.service'
import { evaluateAchievementsInTx } from './achievement.service'
import { enqueueNotificationInTx } from './notification.service'
import { notificationDedupeKeys } from '@/lib/game/config/notifications'
import { recordAdminAuditInTx } from './admin/admin-audit.service'

const log = logger.child({ module: 'game/world' })

type ReadClient = Tx | typeof db

const IDEMPOTENCY_ACTION = 'TERRITORY_ASSAULT'

/** Virtual defender identity inside battle sides (NEVER a real player id). */
const GARRISON_PLAYER_ID = 'WORLD_GARRISON'
const GARRISON_NAME = 'Free Garrison'

/** Battles that share the army regroup clock (one army, one cooldown). */
const COOLDOWN_BATTLE_TYPES = ['PVP_ATTACK', 'TERRITORY_ASSAULT'] as const

const SPOILS_RESOURCES: LootResource[] = ['GOLD', 'WOOD', 'IRON', 'FOOD', 'CRYSTAL']

/** Economy transaction bounds reuse — assaults share the interactive budget. */
const WORLD_TX_OPTIONS = ECONOMY_TX_OPTIONS

// ── Locking (mirrors battle.service — identical lock order) ──────────────────

function runWorldBattleTransaction<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
  return withKeyLock('battle:engine', () =>
    withKeyLock('db:write', () =>
      withWriteRetry(() => dbWrite.$transaction(run, WORLD_TX_OPTIONS)),
    ),
  )
}

// ── World bootstrap (idempotent, lazy) ───────────────────────────────────────

/**
 * Generates the deterministic world ONCE. Guarded by a cheap region count
 * read; the transaction re-checks under the db:write lock, so concurrent
 * callers converge on exactly one generation (the unique grid makes any
 * P2002 race an idempotent no-op — re-verified below).
 */
export async function ensureWorldGenerated(): Promise<void> {
  const existing = await db.region.count()
  if (existing > 0) return
  await withKeyLock('db:write', () =>
    withWriteRetry(() =>
      dbWrite.$transaction(async (tx) => {
        const inner = await tx.region.count()
        if (inner > 0) return
        const world = generateWorld()
        await tx.region.createMany({
          data: world.regions.map((region) => ({
            id: region.id,
            name: region.name,
            minX: region.minX,
            maxX: region.maxX,
            minY: region.minY,
            maxY: region.maxY,
            metadata: region.metadata as unknown as Prisma.InputJsonValue,
          })),
        })
        // Pre-grid rows (capitals created before the world existed) occupy
        // their (x,y) already — exclude them from the batch insert (the
        // fan-out pre-read pattern; skipDuplicates is unsupported on SQLite).
        const existing = await tx.territory.findMany({
          where: { x: { gte: 0, lte: WORLD.sizeX - 1 }, y: { gte: 0, lte: WORLD.sizeY - 1 } },
          select: { x: true, y: true },
        })
        const occupied = new Set(existing.map((row) => `${row.x},${row.y}`))
        await tx.territory.createMany({
          data: world.territories
            .filter((cell) => !occupied.has(`${cell.x},${cell.y}`))
            .map((cell) => ({
              x: cell.x,
              y: cell.y,
              regionId: cell.regionId,
              name: cell.name,
              terrain: cell.terrain,
              status: cell.status,
              type: cell.type,
              strategicValue: cell.strategicValue,
              defenseStrength: cell.defenseStrength,
              resourceType: cell.resourceType,
              productionRate: cell.productionRate,
            })),
        })
        // Backfill the region link for pre-grid rows (capitals created
        // before the world existed). Idempotent conditional updates.
        for (const region of world.regions) {
          await tx.territory.updateMany({
            where: {
              regionId: null,
              x: { gte: region.minX, lte: region.maxX },
              y: { gte: region.minY, lte: region.maxY },
            },
            data: { regionId: region.id },
          })
        }

        // Legacy-capital backfill: players whose city predates the world
        // grid have no capital territory yet. Convert their city cell when
        // it is claimable; log loudly when it is not (never block the world
        // bootstrap — fresh registrations always claim capitals atomically).
        const legacyCities = await tx.city.findMany({
          where: { territory: null },
          select: { id: true, playerId: true, x: true, y: true, name: true },
        })
        for (const city of legacyCities) {
          const claim = await tx.territory.updateMany({
            where: {
              x: city.x,
              y: city.y,
              ownerPlayerId: null,
              isCapital: false,
              status: 'UNCLAIMED',
            },
            data: {
              ownerPlayerId: city.playerId,
              ownerType: 'PLAYER',
              cityId: city.id,
              isCapital: true,
              status: 'CONTROLLED',
              type: 'PLAYER_CITY',
              terrain: 'CITY',
              name: city.name,
              lastCapturedAt: new Date(),
            },
          })
          if (claim.count === 1) {
            const season = await resolveSeasonStateInTx(tx, new Date())
            const territory = await tx.territory.findUnique({
              where: { x_y: { x: city.x, y: city.y } },
              select: { id: true },
            })
            if (territory) {
              await tx.territoryHistory.create({
                data: {
                  territoryId: territory.id,
                  seasonNumber: season?.number ?? 0,
                  previousOwnerType: 'NONE',
                  previousOwnerId: null,
                  newOwnerType: 'PLAYER',
                  newOwnerId: city.playerId,
                  battleId: null,
                  reason: 'SPAWN',
                },
              })
            }
          } else {
            log.error('legacy city cell is not claimable — player has no capital', {
              cityId: city.id,
              x: city.x,
              y: city.y,
            })
          }
        }
        log.info('world generated', {
          regions: world.regions.length,
          territories: world.territories.length,
        })
      }, WORLD_TX_OPTIONS),
    ),
  )
}

// ── Terrain defense modifiers ────────────────────────────────────────────────

/** Exported for the march engine (Phase 33) — ONE terrain-defense mapping. */
export function terrainDefenseModifiers(terrain: string): BpsModifiers {
  const defenseBps = TERRAIN[terrain as TerrainType]?.defenseBps ?? 0
  if (defenseBps === 0) return EMPTY_BPS
  return {
    attackBps: {},
    defenseBps: {
      INFANTRY: defenseBps,
      RANGED: defenseBps,
      CAVALRY: defenseBps,
      SIEGE: defenseBps,
    },
    healthBps: {},
    speedBps: 0,
    lootBps: 0,
  }
}

// ── Virtual garrison loading ─────────────────────────────────────────────────

/** Loads the active unit catalog ONCE per assault (runtime reads the DB). */
/** Exported for the march engine (Phase 33) — ONE garrison catalog loader. */
export async function loadGarrisonCatalog(tx: ReadClient): Promise<GarrisonCatalogRow[]> {
  const rows = await tx.unit.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      class: true,
      attack: true,
      defense: true,
      health: true,
      speed: true,
      strongAgainst: true,
      weakAgainst: true,
      carryCapacity: true,
    },
  })
  return rows as unknown as GarrisonCatalogRow[]
}

// ── Idempotency helpers ──────────────────────────────────────────────────────

function assaultRequestHash(playerId: string, territoryId: string): string {
  return createHash('sha256')
    .update(`${IDEMPOTENCY_ACTION}|${playerId}|${territoryId}|${BATTLE.version}|${WORLD.version}`)
    .digest('hex')
}

// ── Attackability (server-computed — shared by detail view + validation) ─────

export interface AttackabilityReasons {
  attackable: boolean
  reasons: string[]
}

/**
 * Reasons a territory cannot be attacked RIGHT NOW (server state only).
 * Pure-ish: takes preloaded rows; the read view and the assault pipeline use
 * the same vocabulary so the UI never invents rules.
 */
function attackBlockers(input: {
  viewerOwnsTarget: boolean
  isCapital: boolean
  status: string
  seasonActive: boolean
  hasArmy: boolean
  energy: number
  cooldownRemainingSec: number
  hasAdjacentOwnedTerritory: boolean
}): AttackabilityReasons {
  const reasons: string[] = []
  if (!input.seasonActive) reasons.push('SEASON_NOT_ACTIVE')
  if (input.viewerOwnsTarget) reasons.push('OWNED_BY_YOU')
  if (input.isCapital) reasons.push('CAPITAL_PROTECTED')
  if (input.status === 'LOCKED') reasons.push('LOCKED')
  if (!input.hasAdjacentOwnedTerritory) reasons.push('NOT_ADJACENT')
  if (!input.hasArmy) reasons.push('ARMY_EMPTY')
  if (input.energy < WORLD_ATTACK.energyCost) reasons.push('INSUFFICIENT_ENERGY')
  if (input.cooldownRemainingSec > 0) reasons.push('ACTION_ON_COOLDOWN')
  return { attackable: reasons.length === 0, reasons }
}

// ── Views (API surface) ──────────────────────────────────────────────────────

export interface TerritoryMapCell {
  id: string
  x: number
  y: number
  name: string | null
  type: string
  terrain: string
  terrainLabel: string
  terrainColor: string
  status: string
  ownerType: string
  ownerPlayerId: string | null
  ownerName: string | null
  isCapital: boolean
  regionId: string | null
  resourceType: string | null
  productionRate: number
  strategicValue: number
  /** Display resistance hint (garrison size for unclaimed cells). */
  defenseStrength: number
  captureCount: number
}

export interface WorldMapView {
  bounds: { minX: number; maxX: number; minY: number; maxY: number }
  worldSize: { sizeX: number; sizeY: number }
  total: number
  territories: TerritoryMapCell[]
  regions: Array<{
    id: string
    name: string
    minX: number
    maxX: number
    minY: number
    maxY: number
  }>
}

function clampBounds(input: { minX?: number; maxX?: number; minY?: number; maxY?: number }): {
  minX: number
  maxX: number
  minY: number
  maxY: number
} {
  const minX = Math.max(0, Math.min(WORLD.sizeX - 1, Math.floor(input.minX ?? 0)))
  const minY = Math.max(0, Math.min(WORLD.sizeY - 1, Math.floor(input.minY ?? 0)))
  const maxX = Math.max(0, Math.min(WORLD.sizeX - 1, Math.floor(input.maxX ?? WORLD.sizeX - 1)))
  const maxY = Math.max(0, Math.min(WORLD.sizeY - 1, Math.floor(input.maxY ?? WORLD.sizeY - 1)))
  if (minX > maxX || minY > maxY) {
    throw new AppError('VALIDATION_ERROR', 'Invalid map bounds: min exceeds max')
  }
  const area = (maxX - minX + 1) * (maxY - minY + 1)
  if (area > WORLD_MAP_POLICY.maxViewportArea) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Map viewport too large: ${area} cells — max ${WORLD_MAP_POLICY.maxViewportArea}`,
      { maxViewportArea: WORLD_MAP_POLICY.maxViewportArea, requestedArea: area },
    )
  }
  return { minX, maxX, minY, maxY }
}

/** The caller's capital coordinates (map centering) — null when absent. */
async function capitalCoordinates(
  client: ReadClient,
  playerId: string,
): Promise<{ x: number; y: number } | null> {
  const capital = await client.territory.findFirst({
    where: { ownerPlayerId: playerId, isCapital: true },
    select: { x: true, y: true },
  })
  return capital ? { x: capital.x, y: capital.y } : null
}

function toMapCell(row: TerritoryRowLike): TerritoryMapCell {
  const terrain = TERRAIN[row.terrain as TerrainType]
  return {
    id: row.id,
    x: row.x,
    y: row.y,
    name: row.name,
    type: row.type,
    terrain: row.terrain,
    terrainLabel: terrain?.label ?? row.terrain,
    terrainColor: terrain?.color ?? 'zinc',
    status: row.status,
    ownerType: row.ownerType,
    ownerPlayerId: row.ownerPlayerId,
    ownerName: row.ownerPlayer?.name ?? null,
    isCapital: row.isCapital,
    regionId: row.regionId,
    resourceType: row.resourceType,
    productionRate: row.productionRate,
    strategicValue: row.strategicValue,
    defenseStrength: row.defenseStrength,
    captureCount: row.captureCount,
  }
}

/** Structural shape of a territory row joined with its owner (read paths). */
interface TerritoryRowLike {
  id: string
  x: number
  y: number
  name: string | null
  type: string
  terrain: string
  status: string
  ownerType: string
  ownerPlayerId: string | null
  isCapital: boolean
  regionId: string | null
  resourceType: string | null
  productionRate: number
  strategicValue: number
  defenseStrength: number
  captureCount: number
  ownerPlayer?: { name: string } | null
}

/**
 * Viewport map query — indexes make this a bounded range scan, and the area
 * cap (WORLD_MAP_POLICY.maxViewportArea) means the world is NEVER serialized
 * in full. Default bounds (server-decided): a capital-centered square.
 */
export async function getWorldMap(
  playerId: string,
  bounds?: { minX?: number; maxX?: number; minY?: number; maxY?: number },
): Promise<WorldMapView> {
  await ensureWorldGenerated()

  // "Bounds present" means at least ONE bound was actually supplied — an
  // all-undefined object is the no-bounds call (server-picked viewport).
  const hasBounds =
    bounds !== undefined &&
    (bounds.minX !== undefined ||
      bounds.maxX !== undefined ||
      bounds.minY !== undefined ||
      bounds.maxY !== undefined)
  const resolved = hasBounds
    ? clampBounds(bounds!)
    : await (async () => {
        // No client bounds → the server picks the viewport around the capital.
        const center = await capitalCoordinates(db, playerId)
        const r = WORLD_MAP_POLICY.defaultViewportRadius
        const cx = center?.x ?? 0
        const cy = center?.y ?? 0
        return clampBounds({
          minX: cx - r,
          maxX: cx + r,
          minY: cy - r,
          maxY: cy + r,
        })
      })()

  const [rows, regions] = await Promise.all([
    db.territory.findMany({
      where: {
        x: { gte: resolved.minX, lte: resolved.maxX },
        y: { gte: resolved.minY, lte: resolved.maxY },
      },
      orderBy: [{ y: 'asc' }, { x: 'asc' }],
      include: { ownerPlayer: { select: { name: true } } },
    }),
    db.region.findMany({
      where: {
        isActive: true,
        minX: { lte: resolved.maxX },
        maxX: { gte: resolved.minX },
        minY: { lte: resolved.maxY },
        maxY: { gte: resolved.minY },
      },
      select: { id: true, name: true, minX: true, maxX: true, minY: true, maxY: true },
      orderBy: [{ minY: 'asc' }, { minX: 'asc' }],
    }),
  ])

  return {
    bounds: resolved,
    worldSize: { sizeX: WORLD.sizeX, sizeY: WORLD.sizeY },
    total: rows.length,
    territories: rows.map(toMapCell),
    regions,
  }
}

export interface TerritoryDetailView extends TerritoryMapCell {
  region: { id: string; name: string } | null
  attack: AttackabilityReasons
  /** Present when the CALLER owns this producing territory. */
  production: { collectible: boolean; nextCollectAtMs: number | null; pendingAmount: number } | null
}

/**
 * Territory detail — PUBLIC world knowledge only. The defender's private
 * army composition is NEVER included (hidden information, same policy as
 * the battle targets roster); unclaimed cells expose the garrison's SIZE as
 * a resistance hint, never its composition.
 */
export async function getTerritoryDetail(
  playerId: string,
  territoryId: string,
): Promise<TerritoryDetailView> {
  await ensureWorldGenerated()

  const territory = await db.territory.findUnique({
    where: { id: territoryId },
    include: {
      ownerPlayer: { select: { name: true } },
      region: { select: { id: true, name: true } },
    },
  })
  if (!territory) throw new AppError('TERRITORY_NOT_FOUND', 'Territory not found')

  const now = new Date()
  const season = await resolveSeasonState(now)
  const [energy, armyCount, adjacentOwned, lastAttack] = await Promise.all([
    syncPlayerEnergy(db, playerId),
    db.playerUnit.aggregate({ where: { playerId, count: { gt: 0 } }, _sum: { count: true } }),
    db.territory.count({
      where: {
        ownerPlayerId: playerId,
        OR: adjacentCoords(territory.x, territory.y).map((cell) => ({ x: cell.x, y: cell.y })),
      },
    }),
    db.battle.findFirst({
      where: { attackerPlayerId: playerId, type: { in: [...COOLDOWN_BATTLE_TYPES] } },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    }),
  ])
  const cooldownRemainingSec = lastAttack
    ? Math.max(
        0,
        Math.ceil(
          (lastAttack.startedAt.getTime() +
            BATTLE.cooldown.attackCooldownSec * 1000 -
            now.getTime()) /
            1000,
        ),
      )
    : 0

  const attack = attackBlockers({
    viewerOwnsTarget: territory.ownerPlayerId === playerId,
    isCapital: territory.isCapital,
    status: territory.status,
    seasonActive: season?.status === 'ACTIVE',
    hasArmy: (armyCount._sum.count ?? 0) > 0,
    energy: energy.energy,
    cooldownRemainingSec,
    hasAdjacentOwnedTerritory: adjacentOwned > 0,
  })

  let production: TerritoryDetailView['production'] = null
  if (
    territory.ownerPlayerId === playerId &&
    territory.resourceType &&
    territory.productionRate > 0
  ) {
    const cursor =
      territory.productionCollectedAt ?? territory.lastCapturedAt ?? territory.createdAt
    const pending = accruedProduction(
      territory.productionRate,
      territory.terrain,
      now.getTime() - cursor.getTime(),
    )
    const nextCollectAtMs = cursor.getTime() + WORLD_PRODUCTION.minIntervalSec * 1000
    production = {
      collectible:
        pending > 0 && now.getTime() - cursor.getTime() >= WORLD_PRODUCTION.minIntervalSec * 1000,
      nextCollectAtMs: nextCollectAtMs,
      pendingAmount: pending,
    }
  }

  return {
    ...toMapCell(territory),
    region: territory.region ? { id: territory.region.id, name: territory.region.name } : null,
    attack,
    production,
  }
}

export interface PlayerTerritoryRow {
  id: string
  x: number
  y: number
  name: string | null
  isCapital: boolean
  terrain: string
  terrainLabel: string
  status: string
  resourceType: string | null
  productionRate: number
  pendingAmount: number
  collectible: boolean
  nextCollectAtMs: number
  captureCount: number
}

export interface PlayerTerritoriesView {
  capital: PlayerTerritoryRow | null
  territories: PlayerTerritoryRow[]
  total: number
}

/** The caller's own holdings — production readiness computed server-side. */
export async function getPlayerTerritories(playerId: string): Promise<PlayerTerritoriesView> {
  await ensureWorldGenerated()
  const rows = await db.territory.findMany({
    where: { ownerPlayerId: playerId },
    orderBy: [{ isCapital: 'desc' }, { x: 'asc' }, { y: 'asc' }],
    include: { ownerPlayer: { select: { name: true } } },
  })
  const now = Date.now()
  const territories = rows.map((row) => {
    const cursor = row.productionCollectedAt ?? row.lastCapturedAt ?? row.createdAt
    const elapsed = now - cursor.getTime()
    const producing = Boolean(row.resourceType) && row.productionRate > 0
    return {
      id: row.id,
      x: row.x,
      y: row.y,
      name: row.name,
      isCapital: row.isCapital,
      terrain: row.terrain,
      terrainLabel: TERRAIN[row.terrain as TerrainType]?.label ?? row.terrain,
      status: row.status,
      resourceType: row.resourceType,
      productionRate: row.productionRate,
      pendingAmount: producing ? accruedProduction(row.productionRate, row.terrain, elapsed) : 0,
      collectible:
        producing &&
        elapsed >= WORLD_PRODUCTION.minIntervalSec * 1000 &&
        accruedProduction(row.productionRate, row.terrain, elapsed) > 0,
      nextCollectAtMs: cursor.getTime() + WORLD_PRODUCTION.minIntervalSec * 1000,
      captureCount: row.captureCount,
    }
  })
  return {
    capital: territories.find((row) => row.isCapital) ?? null,
    territories,
    total: territories.length,
  }
}

// ── Territory history (append-only public world record) ─────────────────────

export interface TerritoryHistoryRow {
  id: string
  reason: string
  seasonNumber: number
  previousOwner: { id: string | null; name: string | null }
  newOwner: { id: string | null; name: string | null }
  battleId: string | null
  createdAt: string
}

export interface TerritoryHistoryView {
  territory: { id: string; x: number; y: number; name: string | null }
  rows: TerritoryHistoryRow[]
  page: number
  pageSize: number
  total: number
  pages: number
}

/**
 * Ownership history of ONE territory — an authenticated, public world record.
 * It contains NO private data (no armies, no wallets, no ledger): owner ids
 * and names are the same information the map itself exposes.
 */
export async function getTerritoryHistory(
  territoryId: string,
  page: number = 1,
  pageSize: number = WORLD_MAP_POLICY.historyDefaultLimit,
): Promise<TerritoryHistoryView> {
  const territory = await db.territory.findUnique({
    where: { id: territoryId },
    select: { id: true, x: true, y: true, name: true },
  })
  if (!territory) throw new AppError('TERRITORY_NOT_FOUND', 'Territory not found')

  const boundedPage = Math.max(1, Math.floor(page))
  const boundedSize = Math.max(1, Math.min(WORLD_MAP_POLICY.historyMaxLimit, Math.floor(pageSize)))
  const where = { territoryId }
  const [total, rows] = await Promise.all([
    db.territoryHistory.count({ where }),
    db.territoryHistory.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (boundedPage - 1) * boundedSize,
      take: boundedSize,
    }),
  ])

  const playerIds = [
    ...new Set(
      rows
        .flatMap((row) => [row.previousOwnerId, row.newOwnerId])
        .filter((id): id is string => Boolean(id)),
    ),
  ]
  const players = await db.player.findMany({
    where: { id: { in: playerIds } },
    select: { id: true, name: true },
  })
  const names = new Map(players.map((p) => [p.id, p.name]))

  return {
    territory,
    rows: rows.map((row) => ({
      id: row.id,
      reason: row.reason,
      seasonNumber: row.seasonNumber,
      previousOwner: {
        id: row.previousOwnerId,
        name: row.previousOwnerId ? (names.get(row.previousOwnerId) ?? null) : null,
      },
      newOwner: {
        id: row.newOwnerId,
        name: row.newOwnerId ? (names.get(row.newOwnerId) ?? null) : null,
      },
      battleId: row.battleId,
      createdAt: row.createdAt.toISOString(),
    })),
    page: boundedPage,
    pageSize: boundedSize,
    total,
    pages: Math.max(1, Math.ceil(total / boundedSize)),
  }
}

// ── The assault ──────────────────────────────────────────────────────────────

export interface TerritoryAttackResult {
  battleId: string
  outcome: 'VICTORY' | 'DEFEAT' | 'DRAW'
  result: BattleResult
  territory: {
    id: string
    x: number
    y: number
    name: string | null
    terrain: string
    captured: boolean
    captureCount: number
  }
  defender: { playerId: string | null; name: string }
  roundsCount: number
  seed: number
  configVersion: number
  casualties: { attacker: CasualtyRow[]; defender: CasualtyRow[] }
  survivors: { attacker: CasualtyRow[]; defender: CasualtyRow[] }
  /** Capture spoils (config-defined) — territory assaults never raid wallets. */
  spoils: Partial<Record<LootResource, string>>
  honor: { attackerDelta: number; defenderDelta: number }
  xp: { attackerGained: number; attackerLevel: number; attackerLevelsGained: number }
  seasonPointsAwarded: number
  energySpent: number
  cooldownUntil: string
  /** True when this response is a stored replay of an identical request. */
  replayed?: boolean
}

interface LossRow {
  unitTypeId: string
  count: number
}

function outcomeFor(
  result: BattleResult,
  role: 'ATTACKER' | 'DEFENDER',
): TerritoryAttackResult['outcome'] {
  if (result === 'DRAW') return 'DRAW'
  const attackerWon = result === 'ATTACKER_WIN'
  return attackerWon === (role === 'ATTACKER') ? 'VICTORY' : 'DEFEAT'
}

function spoilsSummaryText(spoils: Partial<Record<LootResource, bigint>>): string | undefined {
  const parts = SPOILS_RESOURCES.filter((r) => (spoils[r] ?? 0n) > 0n).map(
    (r) => `${r} ${spoils[r]!.toString()}`,
  )
  if (parts.length === 0) return undefined
  return `Spoils: ${parts.join(' · ')}.`
}

// ── Shared assault resolution (Phase 33 — ONE persistence pipeline) ──────────

export interface AssaultResolutionContext {
  tx: Tx
  now: Date
  /** Active season number (the caller resolved the season gate). */
  seasonNumber: number
  attacker: { playerId: string; name: string; level: number }
  /**
   * Pre-built attacker side. DIRECT assaults pass the home army loaded by
   * loadArmySide; MARCH arrivals pass the expedition manifest stacks —
   * ONE army builder exists (battle.service toBattleStack), never two.
   */
  attackerArmy: { side: BattleSide; names: Map<string, string> }
  territory: {
    id: string
    x: number
    y: number
    name: string | null
    terrain: string
    ownerType: string
    ownerPlayerId: string | null
    strategicValue: number
    resourceType: string | null
    captureCount: number
    regionId: string | null
  }
  defender: {
    side: BattleSide
    names: Map<string, string>
    playerId: string | null
    name: string | null
    wasReal: boolean
  }
  seed: number
  unguarded: boolean
  sim: BattleSimulationResult
  /** Originating march stamped on the battle row (null for direct assaults). */
  marchId: string | null
  /** Energy the caller already spent for this assault (recorded on the row). */
  energySpent: number
  /**
   * TRUE when the attacker's units are the march manifest (in transit — NOT
   * player_units rows). Attacker losses are then NOT decremented from
   * player_units; the caller persists the survivor manifest on the march row.
   */
  attackerUnitsInTransit: boolean
}

export interface AssaultResolutionOutcome {
  battleId: string
  roundsCount: number
  captured: boolean
  captureCount: number
  spoils: Partial<Record<LootResource, bigint>>
  attackerHonorDelta: number
  defenderHonorDelta: number
  attackerXpAmount: number
  attackerXp: GrantXpResult
  seasonPointsAwarded: number
}

/**
 * THE territory-assault persistence pipeline (Phase 33 refactor of the
 * Phase 32 assault core — behavior-preserving). Persists EVERYTHING a
 * resolved assault produces inside the CALLER'S transaction: the battle row
 * (+ rounds), casualties, capture spoils through the ledger, the
 * conditional exactly-once capture + append-only history, honor, XP, season
 * points, statistics, power recalculation, quest events, achievement
 * evaluation, battle logs and outbox notifications.
 *
 * Callers (attackTerritory and the march arrival processor) own validation,
 * energy, army loading and the PURE simulation; this function owns every
 * write. There is exactly ONE pipeline — no second combat persistence path.
 */
export async function resolveTerritoryAssaultInTx(
  ctx: AssaultResolutionContext,
): Promise<AssaultResolutionOutcome> {
  const { tx, now, sim } = ctx
  // ── Persist the battle ──────────────────────────────────────────────────
  const attackerWon = sim.result === 'ATTACKER_WIN'
  const defenderWon = sim.result === 'DEFENDER_WIN'
  const spoils: Partial<Record<LootResource, bigint>> = {}
  if (attackerWon) {
    const spoilsResource = (ctx.territory.resourceType ?? 'GOLD') as LootResource
    const spoilsAmount = Math.min(
      ctx.territory.strategicValue * WORLD_ATTACK.captureSpoilsPerStrategicValue,
      WORLD_ATTACK.captureSpoilsCap,
    )
    if (spoilsAmount > 0) spoils[spoilsResource] = BigInt(spoilsAmount)
  }

  const attackerHonorDelta = attackerWon ? WORLD_ATTACK.captureHonor : 0
  const defenderHonorDelta = ctx.defender.wasReal && defenderWon ? WORLD_ATTACK.defenseWinHonor : 0

  const battle = await tx.battle.create({
    data: {
      type: 'TERRITORY_ASSAULT',
      seed: ctx.seed,
      configVersion: BATTLE.version,
      attackerPlayerId: ctx.attacker.playerId,
      defenderPlayerId: ctx.defender.playerId,
      territoryId: ctx.territory.id,
      marchId: ctx.marchId,
      result: sim.result,
      attackerPower: BigInt(Math.round(sim.attackerPower)),
      defenderPower: BigInt(Math.round(sim.defenderPower)),
      roundsCount: ctx.unguarded ? 0 : new Set(sim.rounds.map((round) => round.roundNumber)).size,
      loot: Object.fromEntries(
        Object.entries(spoils).map(([resource, amount]) => [resource, amount.toString()]),
      ) as Prisma.InputJsonValue,
      honorDelta: attackerHonorDelta,
      reputationDelta: 0,
      energySpent: ctx.energySpent,
      startedAt: now,
      endedAt: now,
    },
  })

  if (sim.rounds.length > 0) {
    await tx.battleRound.createMany({
      data: sim.rounds.map((round) => ({
        battleId: battle.id,
        roundNumber: round.roundNumber,
        side: round.side,
        unitsCommitted: round.unitsCommitted as unknown as Prisma.InputJsonValue,
        unitsLost: round.unitsLost as unknown as Prisma.InputJsonValue,
        damageDealt: BigInt(round.damageDealt),
        events: round.actions as unknown as Prisma.InputJsonValue,
      })),
    })
  }

  const unitNames = new Map<string, string>([...ctx.attackerArmy.names, ...ctx.defender.names])

  // ── Apply casualties (CAS-guarded decrements — never negative) ──────────
  const applyLosses = async (ownerId: string, losses: readonly LossRow[]): Promise<void> => {
    for (const loss of losses) {
      if (loss.count <= 0) continue
      const claim = await tx.playerUnit.updateMany({
        where: { playerId: ownerId, unitId: loss.unitTypeId, count: { gte: loss.count } },
        data: { count: { decrement: loss.count } },
      })
      if (claim.count === 0) {
        throw new AppError('INTERNAL_ERROR', `Casualty invariant violated for ${loss.unitTypeId}`)
      }
    }
  }
  if (!ctx.attackerUnitsInTransit) {
    await applyLosses(ctx.attacker.playerId, sim.attackerLosses)
  } // March armies: losses are settled against the SURVIVORS MANIFEST by the caller.
  if (ctx.defender.wasReal) {
    await applyLosses(ctx.defender.playerId!, sim.defenderLosses)
  }
  // Virtual garrison losses are intentionally NOT persisted anywhere.

  // ── Spoils through the ledger (TERRITORY_CAPTURE) ───────────────────────
  const spoilsEntries = SPOILS_RESOURCES.filter((r) => (spoils[r] ?? 0n) > 0n)
  if (spoilsEntries.length > 0) {
    const amounts: Partial<Record<EconomyResource, bigint>> = {}
    for (const resource of spoilsEntries) {
      amounts[resource as EconomyResource] = spoils[resource]!
    }
    await grantResources(tx, ctx.attacker.playerId, amounts, {
      reason: 'TERRITORY_CAPTURE',
      refType: 'territory',
      refId: ctx.territory.id,
      metadata: { battleId: battle.id } as unknown as Prisma.InputJsonValue,
    })
  }

  // ── Capture (ONLY on ATTACKER_WIN — conditional, exactly-once) ──────────
  let captured = false
  let captureCount = ctx.territory.captureCount
  if (attackerWon) {
    // Conditional ownership flip — exactly-once arbiter. The OR arm is
    // required because SQL NULL semantics exclude NULL rows from `not`.
    const claim = await tx.territory.updateMany({
      where: {
        id: ctx.territory.id,
        OR: [{ ownerPlayerId: null }, { ownerPlayerId: { not: ctx.attacker.playerId } }],
      },
      data: {
        ownerPlayerId: ctx.attacker.playerId,
        ownerType: 'PLAYER',
        status: 'CONTROLLED' as TerritoryStatus,
        lastCapturedAt: now,
        productionCollectedAt: now,
        captureCount: { increment: 1 },
      },
    })
    if (claim.count !== 1) {
      throw new AppError('INTERNAL_ERROR', 'Capture invariant violated — ownership did not flip')
    }
    captured = true
    captureCount = ctx.territory.captureCount + 1

    await tx.territoryHistory.create({
      data: {
        territoryId: ctx.territory.id,
        seasonNumber: ctx.seasonNumber,
        previousOwnerType: ctx.territory.ownerType === 'PLAYER' ? 'PLAYER' : 'NONE',
        previousOwnerId: ctx.territory.ownerPlayerId,
        newOwnerType: 'PLAYER',
        newOwnerId: ctx.attacker.playerId,
        battleId: battle.id,
        reason: 'CAPTURE',
      },
    })
  }

  // ── Rewards: honor, XP, season points ──────────────────────────────────
  if (attackerHonorDelta > 0) {
    await tx.player.update({
      where: { id: ctx.attacker.playerId },
      data: { honor: { increment: BigInt(attackerHonorDelta) } },
    })
  }
  if (defenderHonorDelta > 0) {
    await tx.player.update({
      where: { id: ctx.defender.playerId! },
      data: { honor: { increment: BigInt(defenderHonorDelta) } },
    })
  }

  const attackerXpAmount = attackerWon
    ? WORLD_ATTACK.captureWinXp
    : WORLD_ATTACK.attackParticipationXp
  const attackerXp = await grantXp(tx, {
    playerId: ctx.attacker.playerId,
    amount: attackerXpAmount,
    source: ctx.marchId === null ? 'territory' : 'march',
  })
  if (ctx.defender.wasReal) {
    const defenderXpAmount = defenderWon
      ? WORLD_ATTACK.defenseWinXp
      : WORLD_ATTACK.defenseParticipationXp
    await grantXp(tx, {
      playerId: ctx.defender.playerId!,
      amount: defenderXpAmount,
      source: 'territory',
    })
  }

  let seasonPointsAwarded = 0
  if (attackerWon) {
    seasonPointsAwarded = await awardSeasonPointsInTx(
      tx,
      ctx.attacker.playerId,
      WORLD_ATTACK.captureSeasonPoints,
      'TERRITORY_CAPTURE',
      { battleId: battle.id },
    )
  }
  // A REAL defender who did not lose the territory held it (defense win OR
  // a costly draw) — the same rule drives stats and the quest event below.
  const defenderHeld = ctx.defender.wasReal && !attackerWon
  if (defenderHeld) {
    await awardSeasonPointsInTx(
      tx,
      ctx.defender.playerId!,
      WORLD_ATTACK.defenseSeasonPoints,
      'TERRITORY_DEFENSE',
      { battleId: battle.id },
    )
  }

  // ── Statistics (append-only counters) ──────────────────────────────────
  const sumLosses = (rows: readonly LossRow[]): number =>
    rows.reduce((sum, row) => sum + row.count, 0)
  const attackerStats: Record<string, number> = { attacksLaunched: 1 }
  if (attackerWon) attackerStats['battlesWon'] = 1
  else if (sim.result === 'DEFENDER_WIN') attackerStats['battlesLost'] = 1
  const attackerLostUnits = sumLosses(sim.attackerLosses)
  if (attackerLostUnits > 0) attackerStats['unitsLost'] = attackerLostUnits
  if (captured) attackerStats['territoriesCaptured'] = 1
  await recordPlayerStats(tx, ctx.attacker.playerId, attackerStats)

  if (ctx.defender.wasReal) {
    const defenderStats: Record<string, number> = {}
    if (defenderHeld) defenderStats['defensesWon'] = 1
    else if (attackerWon) defenderStats['battlesLost'] = 1
    const defenderLostUnits = sumLosses(sim.defenderLosses)
    if (defenderLostUnits > 0) defenderStats['unitsLost'] = defenderLostUnits
    if (captured) defenderStats['territoriesLost'] = 1
    if (Object.keys(defenderStats).length > 0) {
      await recordPlayerStats(tx, ctx.defender.playerId!, defenderStats)
    }
  }

  // ── Power recalculation (armies changed) ───────────────────────────────
  await recalculatePlayerPower(tx, ctx.attacker.playerId)
  if (ctx.defender.wasReal) {
    await recalculatePlayerPower(tx, ctx.defender.playerId!)
  }

  // ── Quest events (typed domain events — same transaction) ──────────────
  await applyQuestEventInTx(
    tx,
    ctx.attacker.playerId,
    { kind: 'BATTLE_FINISHED', won: attackerWon, role: 'ATTACKER', battleId: battle.id },
    now,
  )
  let ownedCount = 0
  if (captured) {
    ownedCount = await tx.territory.count({ where: { ownerPlayerId: ctx.attacker.playerId } })
    await applyQuestEventInTx(
      tx,
      ctx.attacker.playerId,
      {
        kind: 'TERRITORY_CAPTURED',
        territoryId: ctx.territory.id,
        regionId: ctx.territory.regionId,
        ownedCount,
        battleId: battle.id,
      },
      now,
    )
  }
  if (ctx.defender.wasReal) {
    await applyQuestEventInTx(
      tx,
      ctx.defender.playerId!,
      {
        kind: 'BATTLE_FINISHED',
        won: defenderWon,
        role: 'DEFENDER',
        battleId: battle.id,
      },
      now,
    )
    if (defenderHeld) {
      await applyQuestEventInTx(
        tx,
        ctx.defender.playerId!,
        { kind: 'TERRITORY_DEFENDED', territoryId: ctx.territory.id, battleId: battle.id },
        now,
      )
    }
    if (captured) {
      await applyQuestEventInTx(
        tx,
        ctx.defender.playerId!,
        { kind: 'TERRITORY_LOST', territoryId: ctx.territory.id, battleId: battle.id },
        now,
      )
    }
  }

  // ── Achievement evaluation (stats settled above) ───────────────────────
  await evaluateAchievementsInTx(tx, ctx.attacker.playerId, {}, now)
  if (ctx.defender.wasReal) {
    await evaluateAchievementsInTx(tx, ctx.defender.playerId!, {}, now)
  }

  // ── Battle logs (per-participant reports) ──────────────────────────────
  const attackerView = {
    battleId: battle.id,
    type: 'TERRITORY_ASSAULT',
    result: sim.result,
    myRole: 'ATTACKER',
    territory: {
      territoryId: ctx.territory.id,
      x: ctx.territory.x,
      y: ctx.territory.y,
      name: ctx.territory.name,
      terrain: ctx.territory.terrain,
    },
    opponent: {
      playerId: ctx.defender.playerId,
      name: ctx.defender.name ?? GARRISON_NAME,
    },
    roundsCount: battle.roundsCount,
    seed: battle.seed,
    configVersion: BATTLE.version,
    unguarded: ctx.unguarded,
    yourArmy: ctx.attackerArmy.side.stacks,
    yourLosses: casualtyRows(sim.attackerLosses, unitNames),
    enemyLosses: casualtyRows(sim.defenderLosses, unitNames),
    spoils: Object.fromEntries(
      Object.entries(spoils).map(([resource, amount]) => [resource, amount.toString()]),
    ),
    captured,
    honorDelta: attackerHonorDelta,
    energySpent: ctx.energySpent,
    startedAt: now.toISOString(),
  }
  const logs: Array<{ playerId: string; role: 'ATTACKER' | 'DEFENDER'; content: unknown }> = [
    { playerId: ctx.attacker.playerId, role: 'ATTACKER', content: attackerView },
  ]
  if (ctx.defender.wasReal) {
    logs.push({
      playerId: ctx.defender.playerId!,
      role: 'DEFENDER',
      content: {
        battleId: battle.id,
        type: 'TERRITORY_ASSAULT',
        result: sim.result,
        myRole: 'DEFENDER',
        territory: {
          territoryId: ctx.territory.id,
          x: ctx.territory.x,
          y: ctx.territory.y,
          name: ctx.territory.name,
          terrain: ctx.territory.terrain,
        },
        opponent: { playerId: ctx.attacker.playerId, name: ctx.attacker.name },
        roundsCount: battle.roundsCount,
        seed: battle.seed,
        configVersion: BATTLE.version,
        yourArmy: ctx.defender.side.stacks,
        yourLosses: casualtyRows(sim.defenderLosses, unitNames),
        enemyLosses: casualtyRows(sim.attackerLosses, unitNames),
        lostTerritory: captured,
        honorDelta: defenderHonorDelta,
        startedAt: now.toISOString(),
      },
    })
  }
  await tx.battleLog.createMany({
    data: logs.map((entry) => ({
      battleId: battle.id,
      playerId: entry.playerId,
      role: entry.role,
      content: entry.content as Prisma.InputJsonValue,
    })),
  })

  // ── Notifications (existing engine — ATTACK_RESULT) ────────────────────
  await enqueueNotificationInTx(tx, {
    playerId: ctx.attacker.playerId,
    type: 'ATTACK_RESULT',
    dedupeKey: notificationDedupeKeys.attackResult(battle.id, ctx.attacker.playerId),
    payload: {
      battleId: battle.id,
      viewerRole: 'ATTACKER',
      outcome: outcomeFor(sim.result, 'ATTACKER'),
      opponentName: ctx.defender.name ?? GARRISON_NAME,
      lootSummary: spoilsSummaryText(spoils),
    },
  })
  if (ctx.defender.wasReal) {
    await enqueueNotificationInTx(tx, {
      playerId: ctx.defender.playerId!,
      type: 'ATTACK_RESULT',
      dedupeKey: notificationDedupeKeys.attackResult(battle.id, ctx.defender.playerId!),
      payload: {
        battleId: battle.id,
        viewerRole: 'DEFENDER',
        outcome: outcomeFor(sim.result, 'DEFENDER'),
        opponentName: ctx.attacker.name,
      },
    })
  }

  return {
    battleId: battle.id,
    roundsCount: battle.roundsCount,
    captured,
    captureCount,
    spoils,
    attackerHonorDelta,
    defenderHonorDelta,
    attackerXpAmount,
    attackerXp,
    seasonPointsAwarded,
  }
}

export interface TerritoryAttackInput {
  territoryId: string
  /** Client-generated key — a repeated submission replays the first assault. */
  idempotencyKey?: string
}

/**
 * The territory assault pipeline. EVERY number below is server-derived; the
 * client cannot influence terrain, seed, garrison, casualties, spoils, or the
 * capture outcome. Capture happens ONLY on ATTACKER_WIN, inside the same
 * transaction, guarded by a conditional ownership update.
 */
export async function attackTerritory(
  playerId: string,
  input: TerritoryAttackInput,
): Promise<TerritoryAttackResult & { replayed?: boolean }> {
  await ensureWorldGenerated()

  const territoryId = input.territoryId
  if (typeof territoryId !== 'string' || territoryId.length === 0 || territoryId.length > 64) {
    throw new AppError('INVALID_TARGET', 'territoryId must be a 1…64 character string')
  }
  const idempotencyKey = input.idempotencyKey
  if (idempotencyKey !== undefined) {
    if (
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.length === 0 ||
      idempotencyKey.length > BATTLE.idempotency.keyMaxLength
    ) {
      throw new AppError(
        'VALIDATION_ERROR',
        `idempotencyKey must be a 1…${BATTLE.idempotency.keyMaxLength} character string`,
      )
    }
  }

  const requestHash = assaultRequestHash(playerId, territoryId)

  // Replay fast-path (read-only) — the authoritative claim happens in-tx.
  if (idempotencyKey !== undefined) {
    const existing = await db.idempotencyKey.findUnique({ where: { key: idempotencyKey } })
    if (existing && existing.expiresAt.getTime() > Date.now()) {
      if (existing.action !== IDEMPOTENCY_ACTION || existing.requestHash !== requestHash) {
        throw new AppError(
          'IDEMPOTENT_REPLAY',
          'Idempotency key was already used for a different request',
        )
      }
      if (existing.responseBody !== null) {
        return { ...(existing.responseBody as unknown as TerritoryAttackResult), replayed: true }
      }
    }
  }

  const now = new Date()

  return runWorldBattleTransaction(async (tx) => {
    // ── Idempotency claim (in-tx) ──────────────────────────────────────────
    if (idempotencyKey !== undefined) {
      const existing = await tx.idempotencyKey.findUnique({ where: { key: idempotencyKey } })
      if (existing) {
        if (existing.expiresAt.getTime() <= now.getTime()) {
          await tx.idempotencyKey.delete({ where: { key: idempotencyKey } })
        } else if (existing.action !== IDEMPOTENCY_ACTION || existing.requestHash !== requestHash) {
          throw new AppError(
            'IDEMPOTENT_REPLAY',
            'Idempotency key was already used for a different request',
          )
        } else if (existing.responseBody !== null) {
          return { ...(existing.responseBody as unknown as TerritoryAttackResult), replayed: true }
        } else {
          throw new AppError('IDEMPOTENT_REPLAY', 'Assault is still in flight — retry shortly')
        }
      }
    }

    // ── Attacker & territory ───────────────────────────────────────────────
    const attacker = await tx.player.findUnique({
      where: { id: playerId },
      select: { id: true, name: true, level: true },
    })
    if (!attacker) throw new AppError('PLAYER_NOT_FOUND', 'Attacker not found')

    const territory = await tx.territory.findUnique({
      where: { id: territoryId },
      select: {
        id: true,
        x: true,
        y: true,
        name: true,
        type: true,
        terrain: true,
        status: true,
        ownerType: true,
        ownerPlayerId: true,
        isCapital: true,
        strategicValue: true,
        resourceType: true,
        captureCount: true,
        region: { select: { id: true, name: true } },
      },
    })
    if (!territory) throw new AppError('TERRITORY_NOT_FOUND', 'Territory not found')

    if (territory.isCapital) {
      throw new AppError(
        'TERRITORY_CAPITAL_PROTECTED',
        'Player capitals can never be attacked or captured',
      )
    }
    if (territory.ownerPlayerId === playerId) {
      throw new AppError('TERRITORY_OWNED', 'You already control this territory')
    }
    if (territory.status === 'LOCKED') {
      throw new AppError('TERRITORY_LOCKED', 'This territory is locked')
    }

    // ── Season gate ────────────────────────────────────────────────────────
    const season = await resolveSeasonStateInTx(tx, now)
    if (!season || season.status !== 'ACTIVE') {
      throw new AppError('SEASON_NOT_ACTIVE', 'Territory assaults require an active season')
    }

    // ── Adjacency (4-directional, derived from coordinates — server rule) ──
    const adjacentOwned = await tx.territory.count({
      where: {
        ownerPlayerId: playerId,
        OR: adjacentCoords(territory.x, territory.y).map((cell) => ({ x: cell.x, y: cell.y })),
      },
    })
    if (adjacentOwned === 0) {
      throw new AppError(
        'TERRITORY_NOT_ADJACENT',
        'You must control a territory adjacent to this one (N/S/E/W) to assault it',
      )
    }

    // ── Cooldown (shared army regroup clock with city raids) ───────────────
    const lastAttack = await tx.battle.findFirst({
      where: { attackerPlayerId: playerId, type: { in: [...COOLDOWN_BATTLE_TYPES] } },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    })
    if (lastAttack) {
      const cooldownEndsAt =
        lastAttack.startedAt.getTime() + BATTLE.cooldown.attackCooldownSec * 1000
      if (cooldownEndsAt > now.getTime()) {
        throw new AppError(
          'ACTION_ON_COOLDOWN',
          'Your army needs time to regroup before attacking again',
          { retryAfterSec: Math.ceil((cooldownEndsAt - now.getTime()) / 1000) },
        )
      }
    }

    // ── Energy (lazy-tick sync + CAS decrement, never below zero) ──────────
    await syncPlayerEnergy(tx, playerId, now)
    const spend = await tx.player.updateMany({
      where: { id: playerId, energy: { gte: WORLD_ATTACK.energyCost } },
      data: { energy: { decrement: WORLD_ATTACK.energyCost } },
    })
    if (spend.count === 0) {
      throw new AppError(
        'INSUFFICIENT_ENERGY',
        `Not enough energy: need ${WORLD_ATTACK.energyCost}`,
        { needed: WORLD_ATTACK.energyCost },
      )
    }

    // ── Armies ─────────────────────────────────────────────────────────────
    const attackerArmy = await loadArmySide(tx, playerId, attacker.name, EMPTY_BPS, 0, 0)
    if (attackerArmy.totalCount <= 0) {
      throw new AppError('ARMY_EMPTY', 'You have no units to attack with')
    }

    let defenderSide: { side: BattleSide; totalCount: number; names: Map<string, string> }
    let defenderPlayerId: string | null = null
    let defenderPlayerName: string | null = null
    let defenderWasReal = false

    if (territory.ownerPlayerId !== null) {
      // Player-owned territory: the owner's REAL army defends it (armies are
      // realm-wide in this model), hardened by the terrain defense modifier.
      defenderWasReal = true
      defenderPlayerId = territory.ownerPlayerId
      const owner = await tx.player.findUnique({
        where: { id: territory.ownerPlayerId },
        select: { id: true, name: true, level: true, user: { select: { isBanned: true } } },
      })
      if (!owner) throw new AppError('INVALID_TARGET', 'Territory owner not found')
      if (owner.user.isBanned) {
        throw new AppError('INVALID_TARGET', 'Territory owner is not attackable')
      }
      defenderPlayerName = owner.name
      defenderSide = await loadArmySide(
        tx,
        owner.id,
        owner.name,
        terrainDefenseModifiers(territory.terrain),
        0,
        BATTLE.casualties.defenderHospitalBps,
      )
    } else {
      // Unclaimed territory: the DETERMINISTIC VIRTUAL GARRISON (documented
      // NPC defender — generated from (worldSeed, x, y), never persisted,
      // losses are virtual, cannot be scouted or looted).
      const catalog = await loadGarrisonCatalog(tx)
      const stacks = garrisonFor(
        WORLD.seed,
        territory.x,
        territory.y,
        territory.strategicValue,
        catalog,
      )
      if (stacks.length === 0) {
        throw new AppError('INTERNAL_ERROR', 'Virtual garrison resolved to an empty army')
      }
      defenderSide = {
        side: {
          playerId: GARRISON_PLAYER_ID,
          name: GARRISON_NAME,
          stacks,
          modifiers: terrainDefenseModifiers(territory.terrain),
          wallLevel: 0,
          hospitalBps: WORLD_GARRISON.hospitalBps,
        },
        totalCount: stacks.reduce((sum, stack) => sum + stack.count, 0),
        names: new Map<string, string>(catalog.map((row) => [row.id, row.name])),
      }
    }

    const unitNames = new Map<string, string>([...attackerArmy.names, ...defenderSide.names])

    // An empty real defense falls without a fight — no rounds, no losses.
    let sim
    let unguarded = false
    let seed = 0
    const configSnapshot = battleConfigSnapshot()
    if (defenderSide.totalCount <= 0 && defenderWasReal) {
      unguarded = true
      sim = {
        result: 'ATTACKER_WIN' as BattleResult,
        rounds: [],
        attackerLosses: [],
        defenderLosses: [],
        attackerSurvivors: attackerArmy.side.stacks.map((s) => ({
          unitTypeId: s.unitTypeId,
          count: s.count,
        })),
        defenderSurvivors: [],
        defenderHospitalized: [],
        loot: {},
        honorDelta: 0,
        reputationDelta: 0,
        attackerPower: attackerArmy.side.stacks.reduce(
          (sum, s) => sum + s.count * (s.attack + s.defense + s.health),
          0,
        ),
        defenderPower: 0,
      }
    } else {
      seed = randomInt(0, 2_147_483_647)
      sim = simulateBattle({
        seed,
        config: configSnapshot,
        attacker: attackerArmy.side,
        defender: defenderSide.side,
        context: {
          type: 'TERRITORY_ASSAULT',
          terrain: territory.terrain as TerrainType,
          coordinate: { x: territory.x, y: territory.y },
        },
      })
    }

    // ── Resolve through the SHARED assault pipeline (Phase 33) ──────────────
    const resolution = await resolveTerritoryAssaultInTx({
      tx,
      now,
      seasonNumber: season.number,
      attacker: { playerId, name: attacker.name, level: attacker.level },
      attackerArmy: { side: attackerArmy.side, names: attackerArmy.names },
      territory: {
        id: territory.id,
        x: territory.x,
        y: territory.y,
        name: territory.name,
        terrain: territory.terrain,
        ownerType: territory.ownerType,
        ownerPlayerId: territory.ownerPlayerId,
        strategicValue: territory.strategicValue,
        resourceType: territory.resourceType,
        captureCount: territory.captureCount,
        regionId: territory.region?.id ?? null,
      },
      defender: {
        side: defenderSide.side,
        names: defenderSide.names,
        playerId: defenderPlayerId,
        name: defenderPlayerName,
        wasReal: defenderWasReal,
      },
      seed,
      unguarded,
      sim,
      marchId: null,
      energySpent: WORLD_ATTACK.energyCost,
      attackerUnitsInTransit: false,
    })
    const captured = resolution.captured
    const captureCount = resolution.captureCount

    // ── Idempotency claim commits WITH the assault ─────────────────────────
    const cooldownUntil = new Date(now.getTime() + BATTLE.cooldown.attackCooldownSec * 1000)
    const response: TerritoryAttackResult = {
      battleId: resolution.battleId,
      outcome: outcomeFor(sim.result, 'ATTACKER'),
      result: sim.result,
      territory: {
        id: territory.id,
        x: territory.x,
        y: territory.y,
        name: territory.name,
        terrain: territory.terrain,
        captured,
        captureCount,
      },
      defender: { playerId: defenderPlayerId, name: defenderPlayerName ?? GARRISON_NAME },
      roundsCount: resolution.roundsCount,
      seed,
      configVersion: BATTLE.version,
      casualties: {
        attacker: casualtyRows(sim.attackerLosses, unitNames),
        defender: casualtyRows(sim.defenderLosses, unitNames),
      },
      survivors: {
        attacker: casualtyRows(sim.attackerSurvivors, unitNames),
        defender: casualtyRows(sim.defenderSurvivors, unitNames),
      },
      spoils: Object.fromEntries(
        Object.entries(resolution.spoils).map(([resource, amount]) => [resource, amount.toString()]),
      ),
      honor: {
        attackerDelta: resolution.attackerHonorDelta,
        defenderDelta: resolution.defenderHonorDelta,
      },
      xp: {
        attackerGained: resolution.attackerXpAmount,
        attackerLevel: resolution.attackerXp.level,
        attackerLevelsGained: resolution.attackerXp.levelsGained,
      },
      seasonPointsAwarded: resolution.seasonPointsAwarded,
      energySpent: WORLD_ATTACK.energyCost,
      cooldownUntil: cooldownUntil.toISOString(),
    }

    if (idempotencyKey !== undefined) {
      await tx.idempotencyKey.create({
        data: {
          key: idempotencyKey,
          playerId,
          action: IDEMPOTENCY_ACTION,
          requestHash,
          responseBody: response as unknown as Prisma.InputJsonValue,
          expiresAt: new Date(now.getTime() + BATTLE.idempotency.ttlSeconds * 1000),
        },
      })
    }

    log.info('territory assault resolved', {
      battleId: resolution.battleId,
      attackerId: playerId,
      territoryId: territory.id,
      result: sim.result,
      captured,
      rounds: resolution.roundsCount,
      seed,
    })

    return response
  })
}

// ── Production collection (lazy, ledger-integrated) ──────────────────────────

export interface TerritoryCollectResult {
  territoryId: string
  resourceType: EconomyResource
  amount: string
  nextCollectAtMs: number
  wallet: Record<string, string>
}

/**
 * Lazy production collection — the ONLY way territory production enters the
 * economy. Owner-only, min-interval-gated, cap-clamped, credited through the
 * EXISTING ledger (TERRITORY_PRODUCTION), so Σ(ledger deltas) == balance.
 * Double collection is impossible: the cursor is advanced in the same
 * transaction behind the player's economy mutex.
 */
export async function collectTerritoryProduction(
  playerId: string,
  territoryId: string,
): Promise<TerritoryCollectResult> {
  return runEconomyTransaction(playerId, async (tx) => {
    const territory = await tx.territory.findUnique({
      where: { id: territoryId },
      select: {
        id: true,
        ownerPlayerId: true,
        status: true,
        terrain: true,
        resourceType: true,
        productionRate: true,
        productionCollectedAt: true,
        lastCapturedAt: true,
        createdAt: true,
      },
    })
    if (!territory) throw new AppError('TERRITORY_NOT_FOUND', 'Territory not found')
    if (territory.ownerPlayerId !== playerId) {
      throw new AppError('FORBIDDEN', 'You do not control this territory')
    }
    if (!territory.resourceType || territory.productionRate <= 0) {
      throw new AppError('TERRITORY_NOT_COLLECTIBLE', 'This territory produces nothing')
    }
    if (territory.status === 'LOCKED') {
      throw new AppError('TERRITORY_NOT_COLLECTIBLE', 'This territory is locked')
    }

    const now = new Date()
    const cursor =
      territory.productionCollectedAt ?? territory.lastCapturedAt ?? territory.createdAt
    const elapsedMs = now.getTime() - cursor.getTime()
    if (elapsedMs < WORLD_PRODUCTION.minIntervalSec * 1000) {
      throw new AppError(
        'TERRITORY_NOT_COLLECTIBLE',
        'Production is not ready yet — the interval has not elapsed',
        {
          retryAfterSec: Math.ceil((WORLD_PRODUCTION.minIntervalSec * 1000 - elapsedMs) / 1000),
        },
      )
    }
    const amount = accruedProduction(territory.productionRate, territory.terrain, elapsedMs)
    if (amount <= 0) {
      throw new AppError(
        'TERRITORY_NOT_COLLECTIBLE',
        'Nothing has accumulated yet — collect again later',
      )
    }

    const grant = await grantResources(
      tx,
      playerId,
      { [territory.resourceType as EconomyResource]: BigInt(amount) } as Partial<
        Record<EconomyResource, bigint>
      >,
      {
        reason: 'TERRITORY_PRODUCTION',
        refType: 'territory',
        refId: territory.id,
      },
    )

    await tx.territory.update({
      where: { id: territory.id },
      data: { productionCollectedAt: now },
    })

    const wallet: Record<string, string> = {}
    for (const entry of grant.applied) {
      wallet[entry.resource] = entry.balanceAfter.toString()
    }

    log.info('territory production collected', {
      playerId,
      territoryId: territory.id,
      resource: territory.resourceType,
      amount,
    })

    return {
      territoryId: territory.id,
      resourceType: territory.resourceType as EconomyResource,
      amount: String(amount),
      nextCollectAtMs: now.getTime() + WORLD_PRODUCTION.minIntervalSec * 1000,
      wallet,
    }
  })
}

// ── Admin operations (RBAC enforced at the route; audited + history here) ────

export interface AdminTerritoryView extends TerritoryMapCell {
  region: { id: string; name: string } | null
  productionCollectedAt: string | null
  lastCapturedAt: string | null
  recentHistory: Array<{
    id: string
    reason: string
    seasonNumber: number
    previousOwnerId: string | null
    newOwnerId: string | null
    battleId: string | null
    createdAt: string
  }>
}

/** Full inspection view — admin scope world.view. Includes the garrison SIZE. */
export async function adminGetTerritory(territoryId: string): Promise<AdminTerritoryView> {
  const territory = await db.territory.findUnique({
    where: { id: territoryId },
    include: {
      ownerPlayer: { select: { name: true } },
      region: { select: { id: true, name: true } },
    },
  })
  if (!territory) throw new AppError('TERRITORY_NOT_FOUND', 'Territory not found')

  const history = await db.territoryHistory.findMany({
    where: { territoryId },
    orderBy: { createdAt: 'desc' },
    take: 10,
  })

  return {
    ...toMapCell(territory),
    region: territory.region,
    productionCollectedAt: territory.productionCollectedAt?.toISOString() ?? null,
    lastCapturedAt: territory.lastCapturedAt?.toISOString() ?? null,
    recentHistory: history.map((row) => ({
      id: row.id,
      reason: row.reason,
      seasonNumber: row.seasonNumber,
      previousOwnerId: row.previousOwnerId,
      newOwnerId: row.newOwnerId,
      battleId: row.battleId,
      createdAt: row.createdAt.toISOString(),
    })),
  }
}

/** Locks/unlocks a territory (LOCKED cells are unattackable AND uncollectible). */
export async function adminSetTerritoryLock(
  actorUserId: string,
  territoryId: string,
  locked: boolean,
): Promise<{ id: string; status: TerritoryStatus }> {
  return runWorldAdminTransaction(async (tx) => {
    const territory = await tx.territory.findUnique({
      where: { id: territoryId },
      select: { id: true, status: true, ownerPlayerId: true, isCapital: true },
    })
    if (!territory) throw new AppError('TERRITORY_NOT_FOUND', 'Territory not found')
    if (territory.isCapital) {
      throw new AppError(
        'TERRITORY_CAPITAL_PROTECTED',
        'Player capitals can never be locked or modified',
      )
    }
    const nextStatus: TerritoryStatus = locked
      ? 'LOCKED'
      : territory.ownerPlayerId !== null
        ? 'CONTROLLED'
        : 'UNCLAIMED'
    await tx.territory.update({
      where: { id: territory.id },
      data: { status: nextStatus },
    })
    await recordAdminAuditInTx(tx, {
      actorUserId,
      action: 'TERRITORY_LOCK',
      targetType: 'territory',
      targetId: territory.id,
      before: { status: territory.status },
      after: { status: nextStatus },
    })
    log.info('admin territory lock changed', { actorUserId, territoryId, locked })
    return { id: territory.id, status: nextStatus }
  })
}

/** Sets territory ownership (RBAC world.manage; audited; history row ADMIN). */
export async function adminSetTerritoryOwnership(
  actorUserId: string,
  territoryId: string,
  ownerPlayerId: string | null,
  reason: string,
): Promise<{ id: string; ownerPlayerId: string | null; status: TerritoryStatus }> {
  if (
    typeof reason !== 'string' ||
    reason.trim().length < WORLD_ADMIN.ownershipReasonMinLength ||
    reason.length > WORLD_ADMIN.ownershipReasonMaxLength
  ) {
    throw new AppError(
      'VALIDATION_ERROR',
      `reason must be ${WORLD_ADMIN.ownershipReasonMinLength}…${WORLD_ADMIN.ownershipReasonMaxLength} characters`,
    )
  }
  return runWorldAdminTransaction(async (tx) => {
    const territory = await tx.territory.findUnique({
      where: { id: territoryId },
      select: {
        id: true,
        status: true,
        ownerType: true,
        ownerPlayerId: true,
        isCapital: true,
        lastCapturedAt: true,
        captureCount: true,
      },
    })
    if (!territory) throw new AppError('TERRITORY_NOT_FOUND', 'Territory not found')
    if (territory.isCapital) {
      throw new AppError(
        'TERRITORY_CAPITAL_PROTECTED',
        'Player capitals can never be reassigned — they are permanently bound to their city',
      )
    }
    if (ownerPlayerId !== null) {
      const owner = await tx.player.findUnique({
        where: { id: ownerPlayerId },
        select: { id: true },
      })
      if (!owner) throw new AppError('PLAYER_NOT_FOUND', 'Owner player not found')
    }

    const season = await resolveSeasonStateInTx(tx, new Date())
    const now = new Date()
    const nextStatus: TerritoryStatus = ownerPlayerId !== null ? 'CONTROLLED' : 'UNCLAIMED'
    await tx.territory.update({
      where: { id: territory.id },
      data: {
        ownerPlayerId,
        ownerType: ownerPlayerId !== null ? 'PLAYER' : 'NONE',
        status: nextStatus,
        lastCapturedAt: ownerPlayerId !== null ? now : territory.lastCapturedAt,
        productionCollectedAt: ownerPlayerId !== null ? now : null,
      },
    })
    await tx.territoryHistory.create({
      data: {
        territoryId: territory.id,
        seasonNumber: season?.number ?? 0,
        previousOwnerType: territory.ownerType === 'PLAYER' ? 'PLAYER' : 'NONE',
        previousOwnerId: territory.ownerPlayerId,
        newOwnerType: ownerPlayerId !== null ? 'PLAYER' : 'NONE',
        newOwnerId: ownerPlayerId,
        battleId: null,
        reason: 'ADMIN',
      },
    })
    await recordAdminAuditInTx(tx, {
      actorUserId,
      action: 'TERRITORY_OWNERSHIP',
      targetType: 'territory',
      targetId: territory.id,
      before: { ownerId: territory.ownerPlayerId, status: territory.status },
      after: { ownerId: ownerPlayerId, status: nextStatus },
      reason,
    })
    log.info('admin territory ownership changed', { actorUserId, territoryId, ownerPlayerId })
    return { id: territory.id, ownerPlayerId, status: nextStatus }
  })
}

/** Admin mutations share the assault's lock order (world consistency). */
function runWorldAdminTransaction<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
  return withKeyLock('db:write', () =>
    withWriteRetry(() => dbWrite.$transaction(run, WORLD_TX_OPTIONS)),
  )
}
