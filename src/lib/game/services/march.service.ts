/**
 * WARLORDS — March service (Phase 33: March & Army Movement Engine).
 *
 * THE single server-side write path for army movement. The client supplies
 * ONLY a destination territory, an action, unit stacks and an optional
 * idempotency key — everything else (origin, distance, speed, terrain,
 * travel time, arrival, battle outcome, casualties, survivors, capture,
 * restorations) is resolved from server state and the data-driven march
 * config (NEVER TRUST THE CLIENT).
 *
 * Pipeline (docs/MARCH-ENGINE.md §Flow):
 *
 *   POST /marches
 *     → idempotency fast-path → runMarchTransaction:
 *         validate season / destination / action / origin / slots / cooldown
 *         → energy CAS  → unit reservation CAS (units LEAVE player_units)
 *         → deterministic travel math → march row (EN_ROUTE) → claim
 *
 *   arrival (lazy, on-demand — processMarch / listMarches / getMarch):
 *     claim EN_ROUTE → RESOLVING (the exactly-once arbiter)
 *       ATTACK   → re-validate destination vs CURRENT state
 *                  → EXISTING assault pipeline (resolveTerritoryAssaultInTx)
 *                  → survivors → RETURNING | all dead → LOST
 *       SCOUT    → ScoutReport (public data class only) → RETURNING
 *       DEFEND / REINFORCE → restore detachment at the destination
 *                            (realm-wide defense model) → COMPLETED
 *   homecoming: claim RETURNING → RESOLVING → restore survivors exactly once
 *               → COMPLETED (+ MARCH_COMPLETED quest event)
 *
 * Concurrency: marches run behind the dedicated `march:engine` mutex and the
 * process-wide `db:write` mutex — the SAME barrier every other game mutation
 * uses (lock order march:engine → db:write; no code path ever takes both an
 * engine key and march:engine, so the composition is deadlock-free). The
 * assault itself reuses the EXISTING battle pipeline pieces — no second
 * battle:engine acquisition is needed because all actual state changes are
 * serialized by db:write and the simulator is pure.
 *
 * Idempotency: a client-supplied key is claimed in the SAME transaction as
 * the march row; a replayed request returns the stored response; the same
 * key with a different request is a typed 409. Arrival/return/cancel are
 * exactly-once through conditional status claims (state-machine arbiters),
 * so double processing is impossible even without a key.
 */

import { Prisma } from '@prisma/client'
import { createHash, randomInt } from 'node:crypto'
import { db, dbWrite } from '@/lib/db'
import { AppError } from '@/lib/api/errors'
import { logger } from '@/lib/logger'
import { withKeyLock } from '@/lib/concurrency/mutex'
import { withWriteRetry } from './player-registration.service'
import type { Tx } from './player-bootstrap.service'
import { MARCH, marchTravelSeconds, scoutSpeedBonusBps } from '@/lib/game/config/march'
import { GARRISON } from '@/lib/game/config/garrison'
import { WORLD } from '@/lib/game/config/world'
import { BATTLE } from '@/lib/game/config/battle'
import type { TerrainType, BattleSide } from '@/lib/game/types/battle'
import { EMPTY_BPS } from '@/lib/game/types/battle'
import type { BattleResult, MarchStatus, MarchType, BattleType } from '@/lib/game/types/common'
import {
  manhattanDistance,
  parseMarchStacks,
  readStoredStacks,
  slowestArmySpeed,
  subtractStacks,
  totalUnits,
  type MarchStack,
  ACTIVE_MARCH_STATUSES,
} from '@/lib/game/engine/march/movement'
import { simulateBattle } from '@/lib/game/engine/battle/simulator'
import { battleConfigSnapshot, loadArmySide, toBattleStack } from './battle.service'
import {
  loadGarrisonCatalog,
  resolveTerritoryAssaultInTx,
  terrainDefenseModifiers,
} from './world.service'
import { garrisonFor, adjacentCoords } from '@/lib/game/engine/world/generator'
import {
  capacityForTerritory,
  deployGarrisonInTx,
  loadGarrisonDefenseInTx,
  resolveGarrisonAuthorization,
  type GarrisonContributionManifest,
} from './garrison.service'
import { effectsFor } from '@/lib/game/config/buildings'
import { syncPlayerEnergy } from './energy.service'
import { resolveSeasonStateInTx } from './season.service'
import { recordPlayerStats } from './stats.service'
import { applyQuestEventInTx } from './quest-events.service'
import { evaluateAchievementsInTx } from './achievement.service'
import { enqueueNotificationInTx } from './notification.service'
import { notificationDedupeKeys } from '@/lib/game/config/notifications'

const log = logger.child({ module: 'game/march' })

type ReadClient = Tx | typeof db

/** Process-wide march serialization key (see module docblock). */
export const MARCH_ENGINE_LOCK = 'march:engine'

/** Battles that share the army regroup clock (one army, one cooldown). */
const COOLDOWN_BATTLE_TYPES = ['PVP_ATTACK', 'TERRITORY_ASSAULT'] as const

const IDEMPOTENCY_ACTION = 'MARCH_CREATE'

/** Economy transaction bounds reuse — marches share the interactive budget. */
const MARCH_TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const

/** Virtual defender identity inside battle sides (mirrors world.service). */
const GARRISON_PLAYER_ID = 'WORLD_GARRISON'
const GARRISON_NAME = 'Free Garrison'

// ── Locking (mirrors battle/world services — identical lock order) ───────────

function runMarchTransaction<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
  return withKeyLock(MARCH_ENGINE_LOCK, () =>
    withKeyLock('db:write', () =>
      withWriteRetry(() => dbWrite.$transaction(run, MARCH_TX_OPTIONS)),
    ),
  )
}

// ── Energy cost per action (server config ONLY) ─────────────────────────────

export function marchEnergyCost(type: MarchType): number {
  switch (type) {
    case 'ATTACK':
      return 10 // = WORLD_ATTACK.energyCost — same combat economy
    case 'SCOUT':
      return BATTLE.energy.scoutCost
    case 'DEFEND':
    case 'REINFORCE':
      return MARCH.repositionEnergyCost
    default:
      throw new AppError('VALIDATION_ERROR', `March type ${type} is not client-requestable`)
  }
}

// ── Idempotency helpers ──────────────────────────────────────────────────────

function marchRequestHash(
  playerId: string,
  territoryId: string,
  type: MarchType,
  stacks: readonly MarchStack[],
): string {
  const canonical = stacks.map((s) => `${s.unitId}:${s.count}`).join('|')
  return createHash('sha256')
    .update(
      `${IDEMPOTENCY_ACTION}|${playerId}|${territoryId}|${type}|${canonical}|${MARCH.version}`,
    )
    .digest('hex')
}

interface ReplayPayload {
  result: MarchView
  replayed: true
}

// ── Unit catalog helpers ─────────────────────────────────────────────────────

interface CatalogSpeedRow {
  id: string
  speed: number
}

async function loadCatalogSpeeds(client: ReadClient): Promise<Map<string, number>> {
  const rows = await client.unit.findMany({
    where: { isActive: true },
    select: { id: true, speed: true },
  })
  return new Map<string, number>((rows as CatalogSpeedRow[]).map((r) => [r.id, r.speed]))
}

/** The REAL building level of the player's castle (march slots). */
async function castleMarchSlots(client: ReadClient, playerId: string): Promise<number> {
  const castle = await client.building.findFirst({
    where: { city: { playerId }, type: 'CASTLE' },
    select: { level: true },
  })
  const effects = effectsFor('CASTLE', castle?.level ?? 1)
  const slots = effects['marchSlots']
  return typeof slots === 'number' && slots >= 1 ? slots : 1
}

/** The REAL Scout Center level (scout march speed bonus). */
async function scoutCenterLevel(client: ReadClient, playerId: string): Promise<number> {
  const center = await client.building.findFirst({
    where: { city: { playerId }, type: 'SCOUT_CENTER' },
    select: { level: true },
  })
  return center?.level ?? 1
}

// ── Views (API surface) ──────────────────────────────────────────────────────

export interface MarchStackView {
  unitId: string
  unitName: string
  count: number
}

export interface MarchOutcomeView {
  /** ATTACK: the battle that resolved the assault (null when aborted). */
  battleId?: string
  result?: BattleResult
  captured?: boolean
  aborted?: string
  scoutReportId?: string
  delivered?: boolean
  unitsLost?: number
  /** Server-written destination coords (used by homecoming notifications). */
  destinationCoord?: { x: number; y: number }
  // Phase 34 — positional garrison lifecycle markers (server-written only).
  /** The detachment is stationed in a TerritoryGarrison (march is ARRIVED). */
  garrisoned?: boolean
  /** The player withdrew the detachment (return leg started by withdrawal). */
  withdrawn?: boolean
  /** Season settlement ended the deployment (detachments released home). */
  seasonReset?: boolean
  /** A battle destroyed this contribution entirely (march → LOST). */
  garrisonDestroyed?: boolean
  /** The territory fell and the surviving garrison was routed (march → LOST). */
  garrisonRouted?: boolean
}

export interface MarchView {
  id: string
  type: MarchType
  status: MarchStatus
  origin: { x: number; y: number }
  destination: {
    territoryId: string | null
    x: number | null
    y: number | null
    name: string | null
    terrain: string | null
  }
  units: MarchStackView[]
  survivors: MarchStackView[] | null
  departedAt: string
  arrivesAt: string
  returnsAt: string | null
  completedAt: string | null
  /** Server clock snapshot — the ONLY time a client countdown may trust. */
  serverNowMs: number
  /** Server verdicts — the client never decides state. */
  cancellable: boolean
  dueNow: boolean
  battleId: string | null
  outcome: MarchOutcomeView | null
}

export interface MarchListView {
  marches: MarchView[]
  activeCount: number
  slots: number
}

interface MarchRowLike {
  id: string
  type: string
  status: string
  originX: number
  originY: number
  departedAt: Date
  arrivesAt: Date
  returnsAt: Date | null
  completedAt: Date | null
  units: unknown
  survivors: unknown
  outcome: unknown
  battleId: string | null
  territory: { id: string; x: number; y: number; name: string | null; terrain: string } | null
}

function outcomeView(raw: unknown): MarchOutcomeView | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  return raw as MarchOutcomeView
}

function toMarchView(
  row: MarchRowLike,
  unitNames: ReadonlyMap<string, string>,
  now: Date,
): MarchView {
  const stacks = readStoredStacks(row.units)
  const survivors = row.survivors === null ? null : readStoredStacks(row.survivors)
  const status = row.status as MarchStatus
  const nowMs = now.getTime()
  return {
    id: row.id,
    type: row.type as MarchType,
    status,
    origin: { x: row.originX, y: row.originY },
    destination: {
      territoryId: row.territory?.id ?? null,
      x: row.territory?.x ?? null,
      y: row.territory?.y ?? null,
      name: row.territory?.name ?? null,
      terrain: row.territory?.terrain ?? null,
    },
    units: stacks.map((s) => ({
      unitId: s.unitId,
      unitName: unitNames.get(s.unitId) ?? s.unitId,
      count: s.count,
    })),
    survivors:
      survivors?.map((s) => ({
        unitId: s.unitId,
        unitName: unitNames.get(s.unitId) ?? s.unitId,
        count: s.count,
      })) ?? null,
    departedAt: row.departedAt.toISOString(),
    arrivesAt: row.arrivesAt.toISOString(),
    returnsAt: row.returnsAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    serverNowMs: nowMs,
    cancellable: status === 'EN_ROUTE',
    dueNow:
      (status === 'EN_ROUTE' && row.arrivesAt.getTime() <= nowMs) ||
      (status === 'RETURNING' && row.returnsAt !== null && row.returnsAt.getTime() <= nowMs),
    battleId: row.battleId,
    outcome: outcomeView(row.outcome),
  }
}

async function loadUnitNames(client: ReadClient): Promise<Map<string, string>> {
  const rows = await client.unit.findMany({ select: { id: true, name: true } })
  return new Map<string, string>(rows.map((r) => [r.id, r.name]))
}

// ── Creation ─────────────────────────────────────────────────────────────────

export interface CreateMarchInput {
  territoryId: string
  type: MarchType
  units: unknown
  /** Client-generated key — a repeated submission replays the first march. */
  idempotencyKey?: string
}

/**
 * Creates a march. EVERY number below is server-derived; the client cannot
 * influence origin, distance, speed, terrain, travel time or the eventual
 * outcome. Invalid requests are zero-write refusals (all validation happens
 * before any write; the transaction rolls back atomically on any failure).
 */
export async function createMarch(playerId: string, input: CreateMarchInput): Promise<MarchView> {
  // ── Zero-write validation (no transaction yet) ───────────────────────────
  const territoryId = input.territoryId
  if (typeof territoryId !== 'string' || territoryId.length === 0 || territoryId.length > 64) {
    throw new AppError('INVALID_TARGET', 'territoryId must be a 1…64 character string')
  }
  const type = input.type
  if (type !== 'ATTACK' && type !== 'DEFEND' && type !== 'SCOUT' && type !== 'REINFORCE') {
    throw new AppError('VALIDATION_ERROR', 'type must be ATTACK, DEFEND, SCOUT or REINFORCE')
  }
  let stacks: MarchStack[]
  try {
    stacks = parseMarchStacks(input.units)
  } catch (err) {
    throw new AppError('MARCH_INVALID_UNITS', err instanceof Error ? err.message : 'Invalid units')
  }

  const idempotencyKey = input.idempotencyKey
  if (idempotencyKey !== undefined) {
    if (
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.length === 0 ||
      idempotencyKey.length > MARCH.idempotency.keyMaxLength
    ) {
      throw new AppError(
        'VALIDATION_ERROR',
        `idempotencyKey must be a 1…${MARCH.idempotency.keyMaxLength} character string`,
      )
    }
  }

  const requestHash = marchRequestHash(playerId, territoryId, type, stacks)

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
        return (existing.responseBody as unknown as ReplayPayload).result
      }
    }
  }

  const now = new Date()

  return runMarchTransaction(async (tx) => {
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
          return (existing.responseBody as unknown as ReplayPayload).result
        } else {
          throw new AppError(
            'IDEMPOTENT_REPLAY',
            'March creation is still in flight — retry shortly',
          )
        }
      }
    }

    // ── Player & season ────────────────────────────────────────────────────
    const player = await tx.player.findUnique({
      where: { id: playerId },
      select: { id: true, name: true, clanId: true },
    })
    if (!player) throw new AppError('PLAYER_NOT_FOUND', 'Player not found')

    const season = await resolveSeasonStateInTx(tx, now)
    if (!season || season.status !== 'ACTIVE') {
      throw new AppError('SEASON_NOT_ACTIVE', 'Marches require an active season')
    }

    // ── Destination ────────────────────────────────────────────────────────
    const territory = await tx.territory.findUnique({
      where: { id: territoryId },
      select: {
        id: true,
        x: true,
        y: true,
        name: true,
        terrain: true,
        status: true,
        ownerType: true,
        ownerPlayerId: true,
        isCapital: true,
        strategicValue: true,
      },
    })
    if (!territory) throw new AppError('TERRITORY_NOT_FOUND', 'Territory not found')
    if (territory.status === 'LOCKED') {
      throw new AppError('TERRITORY_LOCKED', 'This territory is locked')
    }

    if (type === 'ATTACK') {
      if (territory.isCapital) {
        throw new AppError('TERRITORY_CAPITAL_PROTECTED', 'Player capitals can never be attacked')
      }
      if (territory.ownerPlayerId === playerId) {
        throw new AppError('TERRITORY_OWNED', 'You already control this territory')
      }
      // 4-dir adjacency to ANY owned territory — the front line (server rule).
      const adjacentOwned = await tx.territory.count({
        where: {
          ownerPlayerId: playerId,
          OR: adjacentCoords(territory.x, territory.y).map((cell) => ({ x: cell.x, y: cell.y })),
        },
      })
      if (adjacentOwned === 0) {
        throw new AppError(
          'TERRITORY_NOT_ADJACENT',
          'You must control a territory adjacent to this one (N/S/E/W) to march on it',
        )
      }
    } else if (type === 'SCOUT') {
      if (territory.ownerPlayerId === playerId) {
        throw new AppError('TERRITORY_OWNED', 'Scouting your own territory teaches nothing')
      }
      // No adjacency requirement — reconnaissance rides beyond the front line.
      // The travel-time clamp bounds the range.
    } else {
      // DEFEND / REINFORCE — positional-garrison deployment (Phase 34).
      // DEFEND stations a detachment on the caller's OWN territory.
      // REINFORCE additionally allows a SAME-CLAN comrade of the owner to
      // reinforce. Authorization is resolved server-side from CURRENT clan
      // membership (Phase 34 contract; foreign garrisons stay refused).
      const authorization = resolveGarrisonAuthorization({
        type,
        playerId,
        playerClanId: player.clanId,
        territoryOwnerPlayerId: territory.ownerPlayerId,
        territoryOwnerClanId: null, // owner clan resolved below for REINFORCE
      })
      if (type === 'DEFEND') {
        if (!authorization.authorized) {
          throw new AppError(
            'MARCH_DESTINATION_NOT_OWNED',
            'You can only send DEFEND marches to your own territories',
          )
        }
      } else {
        if (territory.ownerPlayerId === playerId) {
          // Reinforcing your own holding is the same garrison pool.
        } else {
          const owner = territory.ownerPlayerId
            ? await tx.player.findUnique({
                where: { id: territory.ownerPlayerId },
                select: { clanId: true },
              })
            : null
          const reinforced = resolveGarrisonAuthorization({
            type,
            playerId,
            playerClanId: player.clanId,
            territoryOwnerPlayerId: territory.ownerPlayerId,
            territoryOwnerClanId: owner?.clanId ?? null,
          })
          if (!reinforced.authorized) {
            throw new AppError(
              'MARCH_DESTINATION_NOT_OWNED',
              'REINFORCE marches require a territory owned by your own clan',
            )
          }
        }
      }
    }

    // ── Origin (server-derived — the caller's capital cell) ────────────────
    const origin = await tx.territory.findFirst({
      where: { ownerPlayerId: playerId, isCapital: true },
      select: { x: true, y: true },
    })
    if (!origin) {
      throw new AppError('MARCH_ORIGIN_NOT_FOUND', 'Marches require a capital to march from')
    }

    // ── Garrison capacity (Phase 34 — soft pre-check at creation) ──────────
    // Re-checked authoritatively at arrival: the garrison can change while
    // the march travels. An over-capacity arrival bounces home (never splits).
    if (type === 'DEFEND' || type === 'REINFORCE') {
      const capacity = capacityForTerritory(territory.strategicValue)
      const stationed = await tx.territoryGarrison.findMany({
        where: { territoryId },
        select: { units: true },
      })
      const currentTotal = stationed.reduce(
        (sum, row) => sum + totalUnits(readStoredStacks(row.units)),
        0,
      )
      const committedTotal = totalUnits(stacks)
      if (
        currentTotal + committedTotal > capacity ||
        stationed.length + 1 > GARRISON.maxContributionsPerTerritory
      ) {
        throw new AppError(
          'MARCH_GARRISON_FULL',
          `Garrison capacity exceeded: ${currentTotal}/${capacity} stationed, ${committedTotal} more requested`,
          { capacity, stationed: currentTotal, requested: committedTotal },
        )
      }
    }

    // ── March slots (CASTLE — the reserved building effect) ────────────────
    const slots = await castleMarchSlots(tx, playerId)
    const activeCount = await tx.march.count({
      where: { playerId, status: { in: [...ACTIVE_MARCH_STATUSES] } },
    })
    if (activeCount >= slots) {
      throw new AppError(
        'MARCH_SLOTS_EXHAUSTED',
        `Your castle commands ${slots} simultaneous march${slots === 1 ? '' : 'es'}`,
        { slots, activeCount },
      )
    }

    // ── Cooldown (shared army regroup clock with battles) ──────────────────
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
          'Your army needs time to regroup before marching again',
          { retryAfterSec: Math.ceil((cooldownEndsAt - now.getTime()) / 1000) },
        )
      }
    }

    // ── Energy (lazy-tick sync + CAS decrement, never below zero) ──────────
    const cost = marchEnergyCost(type)
    if (cost > 0) {
      await syncPlayerEnergy(tx, playerId, now)
      const spend = await tx.player.updateMany({
        where: { id: playerId, energy: { gte: cost } },
        data: { energy: { decrement: cost } },
      })
      if (spend.count === 0) {
        throw new AppError('INSUFFICIENT_ENERGY', `Not enough energy: need ${cost}`, {
          needed: cost,
        })
      }
    }

    // ── Unit reservation (CAS — units LEAVE the home army) ─────────────────
    // The catalog is the validity oracle: unknown or inactive ids refuse.
    const catalogRows = await tx.unit.findMany({
      where: { isActive: true, id: { in: stacks.map((s) => s.unitId) } },
      select: { id: true, speed: true },
    })
    const catalogSpeeds = new Map<string, number>(catalogRows.map((r) => [r.id, r.speed]))
    for (const stack of stacks) {
      if (!catalogSpeeds.has(stack.unitId)) {
        throw new AppError('MARCH_INVALID_UNITS', `Unknown or inactive unit: ${stack.unitId}`)
      }
    }
    for (const stack of stacks) {
      const claim = await tx.playerUnit.updateMany({
        where: { playerId, unitId: stack.unitId, count: { gte: stack.count } },
        data: { count: { decrement: stack.count } },
      })
      if (claim.count === 0) {
        throw new AppError(
          'INSUFFICIENT_UNITS',
          `Not enough ${stack.unitId}: need ${stack.count} (and none may already be marching)`,
        )
      }
    }

    // ── Deterministic travel math (distance × pace × terrain — server only) ─
    const distance = manhattanDistance(origin, { x: territory.x, y: territory.y })
    const armySpeed = slowestArmySpeed(stacks, catalogSpeeds)
    const scoutBonus =
      type === 'SCOUT' ? scoutSpeedBonusBps(await scoutCenterLevel(tx, playerId)) : undefined
    const travelSeconds = marchTravelSeconds({
      distance,
      armySpeed,
      destinationTerrain: territory.terrain as TerrainType,
      scoutSpeedBps: scoutBonus,
    })
    const arrivesAt = new Date(now.getTime() + travelSeconds * 1000)

    // ── Persist the march ──────────────────────────────────────────────────
    const march = await tx.march.create({
      data: {
        playerId,
        territoryId: territory.id,
        targetPlayerId: territory.ownerPlayerId,
        type,
        units: stacks as unknown as Prisma.InputJsonValue,
        originX: origin.x,
        originY: origin.y,
        departedAt: now,
        arrivesAt,
        status: 'EN_ROUTE',
      },
    })

    await recordPlayerStats(tx, playerId, { marchesLaunched: 1 })

    // ── Early warning to the CURRENT player-owner of the destination ───────
    // (Existing ATTACK_INCOMING type — pre-designed march payload. If the
    // ownership changes mid-flight the arrival battle notifies the actual
    // defender through the assault pipeline.)
    if (type === 'ATTACK' && territory.ownerPlayerId !== null) {
      await enqueueNotificationInTx(tx, {
        playerId: territory.ownerPlayerId,
        type: 'ATTACK_INCOMING',
        dedupeKey: notificationDedupeKeys.attackIncoming(march.id, territory.ownerPlayerId),
        payload: {
          marchId: march.id,
          attackerName: player.name,
          targetCoord: { x: territory.x, y: territory.y },
          arrivesInSeconds: travelSeconds,
        },
      })
    }

    // ── Idempotency claim commits WITH the march ───────────────────────────
    const view = toMarchView(
      {
        ...march,
        territory: {
          id: territory.id,
          x: territory.x,
          y: territory.y,
          name: territory.name,
          terrain: territory.terrain,
        },
      },
      await loadUnitNames(tx),
      now,
    )

    if (idempotencyKey !== undefined) {
      await tx.idempotencyKey.create({
        data: {
          key: idempotencyKey,
          playerId,
          action: IDEMPOTENCY_ACTION,
          requestHash,
          responseBody: { result: view } as unknown as Prisma.InputJsonValue,
          expiresAt: new Date(now.getTime() + MARCH.idempotency.ttlSeconds * 1000),
        },
      })
    }

    log.info('march created', {
      marchId: march.id,
      playerId,
      type,
      territoryId: territory.id,
      distance,
      travelSeconds,
      arrivesAt: arrivesAt.toISOString(),
    })

    return view
  })
}

// ── Reading (lazy processing on demand — no new worker infrastructure) ───────

const MARCH_INCLUDE = {
  territory: {
    select: { id: true, x: true, y: true, name: true, terrain: true },
  },
} as const

/** Lists the caller's marches — newest first — after processing any due ones. */
export async function listMarches(playerId: string): Promise<MarchListView> {
  await processDueMarches(playerId)
  const now = new Date()
  const [rows, names, slots] = await Promise.all([
    db.march.findMany({
      where: { playerId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: MARCH_INCLUDE,
    }),
    loadUnitNames(db),
    castleMarchSlots(db, playerId),
  ])
  const marches = rows.map((row) => toMarchView(row, names, now))
  return {
    marches,
    activeCount: marches.filter((m) => ACTIVE_MARCH_STATUSES.includes(m.status)).length,
    slots,
  }
}

/** One march (owner-only — a foreign id is a NOT_FOUND, never a leak). */
export async function getMarch(playerId: string, marchId: string): Promise<MarchView> {
  if (typeof marchId !== 'string' || marchId.length === 0 || marchId.length > 64) {
    throw new AppError('MARCH_NOT_FOUND', 'March not found')
  }
  const row = await db.march.findUnique({
    where: { id: marchId },
    select: { playerId: true },
  })
  if (!row || row.playerId !== playerId) {
    throw new AppError('MARCH_NOT_FOUND', 'March not found')
  }
  await processMarchById(marchId)
  const now = new Date()
  const fresh = await db.march.findUnique({ where: { id: marchId }, include: MARCH_INCLUDE })
  if (!fresh) throw new AppError('MARCH_NOT_FOUND', 'March not found')
  return toMarchView(fresh, await loadUnitNames(db), now)
}

// ── Cancellation (EN_ROUTE only — the arrival claim is the race arbiter) ─────

export interface CancelMarchResult {
  march: MarchView
  unitsReleased: number
  /** Mobilization energy is NEVER refunded (config policy — documented). */
  energyRefunded: number
}

export async function cancelMarch(playerId: string, marchId: string): Promise<CancelMarchResult> {
  if (typeof marchId !== 'string' || marchId.length === 0 || marchId.length > 64) {
    throw new AppError('MARCH_NOT_FOUND', 'March not found')
  }
  const now = new Date()
  return runMarchTransaction(async (tx) => {
    const row = await tx.march.findUnique({
      where: { id: marchId },
      include: MARCH_INCLUDE,
    })
    if (!row || row.playerId !== playerId) {
      throw new AppError('MARCH_NOT_FOUND', 'March not found')
    }
    if (row.status !== 'EN_ROUTE') {
      throw new AppError(
        'MARCH_NOT_CANCELLABLE',
        'Only a march that is still traveling can be recalled',
        { status: row.status },
      )
    }

    // The exactly-once arbiter: conditional transition EN_ROUTE → CANCELLED.
    // If the arrival processor claimed the row first, this update hits 0 rows.
    const claim = await tx.march.updateMany({
      where: { id: marchId, status: 'EN_ROUTE' },
      data: { status: 'CANCELLED', completedAt: now },
    })
    if (claim.count !== 1) {
      throw new AppError(
        'MARCH_NOT_CANCELLABLE',
        'The march is already being processed and can no longer be recalled',
      )
    }

    // Restore the EXACT reservation manifest (immutable snapshot).
    const stacks = readStoredStacks(row.units)
    await restoreStacks(tx, playerId, stacks)

    await enqueueNotificationInTx(tx, {
      playerId,
      type: 'MARCH_CANCELLED',
      dedupeKey: notificationDedupeKeys.marchCancelled(marchId),
      payload: {
        marchId,
        action: row.type as 'ATTACK' | 'DEFEND' | 'SCOUT' | 'REINFORCE',
        unitsReleased: totalUnits(stacks),
        destinationCoord: {
          x: row.territory?.x ?? row.originX,
          y: row.territory?.y ?? row.originY,
        },
      },
    })

    const fresh = await tx.march.findUnique({ where: { id: marchId }, include: MARCH_INCLUDE })
    if (!fresh) throw new AppError('MARCH_NOT_FOUND', 'March not found')

    log.info('march cancelled', { marchId, playerId, unitsReleased: totalUnits(stacks) })

    return {
      march: toMarchView(fresh, await loadUnitNames(tx), now),
      unitsReleased: totalUnits(stacks),
      energyRefunded: 0,
    }
  })
}

// ── Garrison withdrawal (Phase 34 — positional detachment recall) ────────────

export interface WithdrawGarrisonResult {
  march: MarchView
  unitsReturning: number
}

/**
 * Recalls a STATIONED positional detachment home. The march must be ARRIVED
 * (delivered to a TerritoryGarrison and still holding a contribution row).
 *
 * Exactly-once: the conditional ARRIVED → RETURNING claim is the arbiter —
 * a racing battle settlement that destroys the contribution transitions the
 * march to LOST first, so the claim hits 0 rows and the withdrawal refuses
 * (dead troops can never be withdrawn). Surviving units ride the EXISTING
 * return-leg/homecoming machinery: survivors = the CURRENT contribution
 * manifest (post-battle), restoration happens exactly once in processReturnInTx.
 *
 * Concurrency: same lock order as every march mutation (march:engine →
 * db:write); battles serialize through db:write, so the contribution read,
 * the claim and the delete are atomic against any battle outcome.
 */
export async function withdrawGarrison(
  playerId: string,
  marchId: string,
): Promise<WithdrawGarrisonResult> {
  if (typeof marchId !== 'string' || marchId.length === 0 || marchId.length > 64) {
    throw new AppError('MARCH_NOT_FOUND', 'March not found')
  }
  const now = new Date()
  return runMarchTransaction(async (tx) => {
    const row = await tx.march.findUnique({
      where: { id: marchId },
      include: MARCH_INCLUDE,
    })
    if (!row || row.playerId !== playerId) {
      // Foreign march ids are a NOT_FOUND — never a leak (Phase 33 rule).
      throw new AppError('MARCH_NOT_FOUND', 'March not found')
    }
    if (row.status !== 'ARRIVED') {
      throw new AppError(
        'MARCH_NOT_WITHDRAWABLE',
        'Only a stationed garrison march can be withdrawn',
        { status: row.status },
      )
    }
    const contribution = await tx.territoryGarrison.findUnique({
      where: { marchId },
      select: { id: true, units: true, territoryId: true },
    })
    if (!contribution) {
      // Invariant: an ARRIVED march always holds its contribution (the
      // battle settlement that deletes the row also transitions the march).
      throw new AppError('INTERNAL_ERROR', 'Stationed march has no garrison contribution')
    }

    // The exactly-once arbiter: conditional ARRIVED → RETURNING.
    const claim = await tx.march.updateMany({
      where: { id: marchId, playerId, status: 'ARRIVED' },
      data: { status: 'RETURNING' },
    })
    if (claim.count !== 1) {
      throw new AppError(
        'MARCH_NOT_WITHDRAWABLE',
        'The garrison march can no longer be withdrawn (battle settled it)',
        { status: row.status },
      )
    }

    // Release the positional contribution — the survivors ride home.
    const survivors = readStoredStacks(contribution.units)
    const deleted = await tx.territoryGarrison.deleteMany({ where: { id: contribution.id } })
    if (deleted.count !== 1) {
      throw new AppError('INTERNAL_ERROR', 'Garrison contribution vanished mid-withdrawal')
    }

    const destinationCoord = {
      x: row.territory?.x ?? row.originX,
      y: row.territory?.y ?? row.originY,
    }
    const priorOutcome = outcomeView(row.outcome)
    await startReturnLeg(
      tx,
      row,
      destinationCoord,
      now,
      survivors,
      { ...priorOutcome, withdrawn: true, destinationCoord },
      null,
      false,
    )
    await recordPlayerStats(tx, playerId, { garrisonWithdrawals: 1 })
    await enqueueNotificationInTx(tx, {
      playerId,
      type: 'GARRISON_WITHDRAWN',
      dedupeKey: notificationDedupeKeys.garrisonWithdrawn(marchId),
      payload: {
        marchId,
        territoryId: contribution.territoryId,
        coord: destinationCoord,
        unitsReturning: totalUnits(survivors),
      },
    })

    const fresh = await tx.march.findUnique({ where: { id: marchId }, include: MARCH_INCLUDE })
    if (!fresh) throw new AppError('MARCH_NOT_FOUND', 'March not found')
    log.info('garrison withdrawn', { marchId, playerId, unitsReturning: totalUnits(survivors) })
    return {
      march: toMarchView(fresh, await loadUnitNames(tx), now),
      unitsReturning: totalUnits(survivors),
    }
  })
}

/**
 * Phase 34 — SEASON SETTLEMENT hook: every stationed detachment on the given
 * (stripped) territories marches home through the EXISTING return leg.
 * Conditional ARRIVED → RETURNING claims keep this idempotent against races;
 * contributions are released and homecoming restores the survivors.
 * Returns the number of detachments released.
 */
export async function releaseTerritoryGarrisonsInTx(
  tx: Tx,
  territoryIds: readonly string[],
  now: Date,
): Promise<number> {
  if (territoryIds.length === 0) return 0
  const coords = new Map(
    (
      await tx.territory.findMany({
        where: { id: { in: [...territoryIds] } },
        select: { id: true, x: true, y: true },
      })
    ).map((row) => [row.id, { x: row.x, y: row.y }]),
  )
  const contributions = await tx.territoryGarrison.findMany({
    where: { territoryId: { in: [...territoryIds] } },
    select: { id: true, marchId: true, territoryId: true, units: true },
  })
  let released = 0
  for (const contribution of contributions) {
    const claim = await tx.march.updateMany({
      where: { id: contribution.marchId, status: 'ARRIVED' },
      data: { status: 'RETURNING' },
    })
    if (claim.count !== 1) continue // raced withdrawal/battle — not ours anymore
    const deleted = await tx.territoryGarrison.deleteMany({ where: { id: contribution.id } })
    if (deleted.count !== 1) {
      throw new AppError('INTERNAL_ERROR', 'Season garrison release invariant violated')
    }
    const march = await tx.march.findUnique({
      where: { id: contribution.marchId },
      select: { id: true, playerId: true, type: true, originX: true, originY: true },
    })
    if (!march) {
      throw new AppError('INTERNAL_ERROR', 'Released garrison march vanished mid-settlement')
    }
    const destinationCoord = coords.get(contribution.territoryId) ?? {
      x: march.originX,
      y: march.originY,
    }
    await startReturnLeg(
      tx,
      march,
      destinationCoord,
      now,
      readStoredStacks(contribution.units),
      { withdrawn: true, seasonReset: true, destinationCoord },
      null,
      false,
    )
    released += 1
  }
  return released
}

// ── Processing (the lazy arrival/homecoming engine) ──────────────────────────

export interface ProcessMarchResult {
  march: MarchView
  /** True when this call actually transitioned the march (arrival or return). */
  processed: boolean
}

/**
 * Server-authoritative progress check. Processes the march when the SERVER
 * clock says it is due; otherwise a no-op with the current state. The client
 * may display countdowns from server timestamps — it can never decide that a
 * march has arrived.
 */
export async function processMarch(playerId: string, marchId: string): Promise<ProcessMarchResult> {
  // Ownership guard + existence check (foreign ids are a NOT_FOUND, never a leak).
  const row = await db.march.findUnique({
    where: { id: marchId },
    select: { playerId: true, status: true },
  })
  if (!row || row.playerId !== playerId) {
    throw new AppError('MARCH_NOT_FOUND', 'March not found')
  }
  const before = row.status
  await processMarchById(marchId)
  const after = await db.march.findUnique({
    where: { id: marchId },
    select: { status: true },
  })
  const view = await getMarch(playerId, marchId) // read model (already processed)
  return { march: view, processed: before !== (after?.status ?? before) }
}

/** Processes every due march of one player (independent transactions each). */
export async function processDueMarches(playerId: string): Promise<number> {
  const now = new Date()
  const due = await db.march.findMany({
    where: {
      playerId,
      OR: [
        { status: 'EN_ROUTE', arrivesAt: { lte: now } },
        { status: 'RETURNING', returnsAt: { lte: now } },
      ],
    },
    select: { id: true },
    take: 50,
  })
  let processed = 0
  for (const row of due) {
    const did = await processMarchById(row.id)
    if (did) processed += 1
  }
  return processed
}

/** Idempotent single-march processing — true when a transition happened. */
async function processMarchById(marchId: string): Promise<boolean> {
  const row = await db.march.findUnique({
    where: { id: marchId },
    select: { status: true, arrivesAt: true, returnsAt: true },
  })
  if (!row) return false
  const now = new Date()
  if (row.status === 'EN_ROUTE' && row.arrivesAt.getTime() <= now.getTime()) {
    await runMarchTransaction((tx) => processArrivalInTx(tx, marchId, now))
    // A successful arrival may have started a return leg — try homecoming too.
    const after = await db.march.findUnique({
      where: { id: marchId },
      select: { returnsAt: true, status: true },
    })
    if (
      after?.status === 'RETURNING' &&
      after.returnsAt &&
      after.returnsAt.getTime() <= Date.now()
    ) {
      await runMarchTransaction((tx) => processReturnInTx(tx, marchId, new Date()))
    }
    return true
  }
  if (
    row.status === 'RETURNING' &&
    row.returnsAt !== null &&
    row.returnsAt.getTime() <= now.getTime()
  ) {
    await runMarchTransaction((tx) => processReturnInTx(tx, marchId, now))
    return true
  }
  return false
}

// ── Unit restoration (exactly-once — increments from the manifest) ───────────

async function restoreStacks(
  tx: Tx,
  playerId: string,
  stacks: readonly MarchStack[],
): Promise<void> {
  for (const stack of stacks) {
    const existing = await tx.playerUnit.findUnique({
      where: { playerId_unitId: { playerId, unitId: stack.unitId } },
      select: { id: true },
    })
    if (existing) {
      await tx.playerUnit.update({
        where: { id: existing.id },
        data: { count: { increment: stack.count } },
      })
    } else {
      await tx.playerUnit.create({
        data: { playerId, unitId: stack.unitId, count: stack.count },
      })
    }
  }
}

// ── Arrival ──────────────────────────────────────────────────────────────────

/**
 * The arrival transaction. The conditional EN_ROUTE → RESOLVING claim is the
 * exactly-once arbiter: a second processor's claim hits 0 rows and resolves
 * as a no-op. RESOLVING is transient — the same transaction finalizes the
 * march to RETURNING / COMPLETED / LOST, so the committed state never rests
 * mid-processing.
 */
export async function processArrivalInTx(tx: Tx, marchId: string, now: Date): Promise<boolean> {
  const claim = await tx.march.updateMany({
    where: { id: marchId, status: 'EN_ROUTE', arrivesAt: { lte: now } },
    data: { status: 'RESOLVING' },
  })
  if (claim.count === 0) return false // not due, or another processor won — idempotent no-op

  const march = await tx.march.findUnique({
    where: { id: marchId },
    include: {
      territory: {
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
          regionId: true,
        },
      },
    },
  })
  if (!march) throw new AppError('INTERNAL_ERROR', `March ${marchId} vanished mid-processing`)
  const committed = readStoredStacks(march.units)
  if (!march.territory) {
    // Defensive: the destination was removed — return home without action.
    await startReturnLeg(
      tx,
      march,
      { x: march.originX, y: march.originY },
      now,
      committed,
      { aborted: 'DESTINATION_GONE' },
      null,
      false,
    )
    return true
  }
  const territory = march.territory
  const destinationCoord = { x: territory.x, y: territory.y }

  // ── DEFEND / REINFORCE: station the detachment as a positional garrison ──
  if (march.type === 'DEFEND' || march.type === 'REINFORCE') {
    // Re-validate authorization against CURRENT state (ownership, clan
    // membership and lock state may all have changed mid-flight).
    const player = await tx.player.findUnique({
      where: { id: march.playerId },
      select: { name: true, clanId: true },
    })
    if (!player) {
      // The marcher vanished mid-flight — the detachment turns around.
      await startReturnLeg(
        tx,
        march,
        destinationCoord,
        now,
        committed,
        { aborted: 'MARCHER_GONE' },
        null,
        false,
      )
      return true
    }
    const owner = territory.ownerPlayerId
      ? await tx.player.findUnique({
          where: { id: territory.ownerPlayerId },
          select: { id: true, clanId: true },
        })
      : null
    const authorization = resolveGarrisonAuthorization({
      type: march.type,
      playerId: march.playerId,
      playerClanId: player.clanId,
      territoryOwnerPlayerId: territory.ownerPlayerId,
      territoryOwnerClanId: owner?.clanId ?? null,
    })
    if (
      territory.status === 'LOCKED' ||
      !authorization.authorized ||
      (march.type === 'DEFEND' && territory.ownerPlayerId !== march.playerId)
    ) {
      // Destination no longer ours/authorized (season settlement, capture,
      // clan departure…) — the detachment turns around and heads home.
      await startReturnLeg(
        tx,
        march,
        destinationCoord,
        now,
        committed,
        {
          aborted:
            march.type === 'DEFEND' ? 'DESTINATION_NO_LONGER_OURS' : 'DESTINATION_NOT_AUTHORIZED',
        },
        null,
        false,
      )
      return true
    }

    // Capacity re-check (STEP 9 — the garrison may have grown mid-flight).
    const capacity = capacityForTerritory(territory.strategicValue)
    const stationedRows = await tx.territoryGarrison.findMany({
      where: { territoryId: territory.id },
      select: { units: true },
    })
    const stationedTotal = stationedRows.reduce(
      (sum, row) => sum + totalUnits(readStoredStacks(row.units)),
      0,
    )
    if (
      stationedTotal + totalUnits(committed) > capacity ||
      stationedRows.length + 1 > GARRISON.maxContributionsPerTerritory
    ) {
      // Over-capacity arrival — the WHOLE detachment bounces home (units are
      // never split or dropped; documented Phase 34 policy).
      await startReturnLeg(
        tx,
        march,
        destinationCoord,
        now,
        committed,
        { aborted: 'GARRISON_CAPACITY_EXCEEDED' },
        null,
        false,
      )
      return true
    }

    // Deploy: the arriving units BECOME the positional defense (Phase 34).
    // The march parks on ARRIVED — withdrawal later claims ARRIVED →
    // RETURNING and the homecoming processor restores the survivors.
    await deployGarrisonInTx(tx, {
      marchId,
      territoryId: territory.id,
      playerId: march.playerId,
      clanId: player.clanId,
      committed,
      now,
    })
    await tx.march.update({
      where: { id: marchId },
      data: {
        status: 'ARRIVED',
        survivors: committed as unknown as Prisma.InputJsonValue,
        outcome: {
          delivered: true,
          garrisoned: true,
          destinationCoord,
        } as unknown as Prisma.InputJsonValue,
      },
    })
    await recordPlayerStats(tx, march.playerId, { garrisonsDeployed: 1 })
    await applyQuestEventInTx(
      tx,
      march.playerId,
      {
        kind: 'GARRISON_DEPLOYED',
        marchId,
        territoryId: territory.id,
        action: march.type,
      },
      now,
    )
    await evaluateAchievementsInTx(tx, march.playerId, {}, now)
    // Deployer confirmation (+ owner alert on foreign reinforcement).
    await enqueueNotificationInTx(tx, {
      playerId: march.playerId,
      type: 'GARRISON_DEPLOYED',
      dedupeKey: notificationDedupeKeys.garrisonDeployed(marchId, march.playerId),
      payload: {
        marchId,
        action: march.type,
        territoryId: territory.id,
        coord: destinationCoord,
        unitsDeployed: totalUnits(committed),
      },
    })
    if (
      march.type === 'REINFORCE' &&
      territory.ownerPlayerId !== null &&
      territory.ownerPlayerId !== march.playerId
    ) {
      await enqueueNotificationInTx(tx, {
        playerId: territory.ownerPlayerId,
        type: 'GARRISON_DEPLOYED',
        dedupeKey: notificationDedupeKeys.garrisonDeployed(marchId, territory.ownerPlayerId),
        payload: {
          marchId,
          action: march.type,
          territoryId: territory.id,
          coord: destinationCoord,
          unitsDeployed: totalUnits(committed),
          contributorName: player.name,
        },
      })
    }
    log.info('march deployed to garrison', {
      marchId,
      playerId: march.playerId,
      type: march.type,
      territoryId: territory.id,
    })
    return true
  }

  // ── ATTACK / SCOUT: re-validate the destination against CURRENT state ───
  const staleTarget =
    (march.type === 'ATTACK' &&
      (territory.isCapital || territory.ownerPlayerId === march.playerId)) ||
    (march.type === 'SCOUT' && territory.ownerPlayerId === march.playerId)
  if (staleTarget || territory.status === 'LOCKED') {
    // Stale intel — no battle, no report: the detachment turns around.
    await startReturnLeg(
      tx,
      march,
      destinationCoord,
      now,
      committed,
      { aborted: territory.status === 'LOCKED' ? 'TERRITORY_LOCKED' : 'STALE_TARGET' },
      null,
      false,
    )
    return true
  }

  // ── SCOUT: one report, public data class only, then ride home ───────────
  if (march.type === 'SCOUT') {
    const owner = territory.ownerPlayerId
      ? await tx.player.findUnique({
          where: { id: territory.ownerPlayerId },
          select: { name: true },
        })
      : null
    const report = await tx.scoutReport.create({
      data: {
        attackerPlayerId: march.playerId,
        targetPlayerId: territory.ownerPlayerId,
        territoryId: territory.id,
        // PUBLIC world knowledge ONLY — the same fields the map/detail views
        // expose. NO private army composition, NO wallet, NO server-only values.
        data: {
          territoryId: territory.id,
          x: territory.x,
          y: territory.y,
          name: territory.name,
          terrain: territory.terrain,
          status: territory.status,
          ownerType: territory.ownerType,
          ownerName: owner?.name ?? null,
          isCapital: territory.isCapital,
          strategicValue: territory.strategicValue,
          defenseStrengthHint: true, // the garrison SIZE is public; its composition is not
          resourceType: territory.resourceType,
          captureCount: territory.captureCount,
          scoutedAt: now.toISOString(),
        } as unknown as Prisma.InputJsonValue,
        success: true,
        expiresAt: new Date(now.getTime() + MARCH.scoutReportTtlHours * 3_600_000),
      },
    })
    await recordPlayerStats(tx, march.playerId, { marchesScouted: 1 })
    await applyQuestEventInTx(
      tx,
      march.playerId,
      { kind: 'MARCH_SCOUTED', marchId, territoryId: territory.id },
      now,
    )
    await evaluateAchievementsInTx(tx, march.playerId, {}, now)
    await startReturnLeg(
      tx,
      march,
      destinationCoord,
      now,
      committed,
      { scoutReportId: report.id, destinationCoord },
      null,
      false,
    )
    return true
  }

  // ── ATTACK: the EXISTING territory assault (one pipeline, one simulator) ─
  await resolveMarchAssaultInTx(tx, march, territory, committed, now)
  return true
}

/**
 * The march attacker resolves through the SHARED assault pipeline. The ONLY
 * difference from a direct assault: the attacker's stacks are the march
 * manifest (units in transit are not player_units rows), so attacker
 * casualties settle against the SURVIVORS MANIFEST instead of player_units.
 */
async function resolveMarchAssaultInTx(
  tx: Tx,
  march: {
    id: string
    playerId: string
    type: string
    originX: number
    originY: number
  },
  territory: {
    id: string
    x: number
    y: number
    name: string | null
    terrain: string
    ownerType: string
    ownerPlayerId: string | null
    isCapital: boolean
    strategicValue: number
    resourceType: string | null
    captureCount: number
    regionId: string | null
  },
  committed: readonly MarchStack[],
  now: Date,
): Promise<void> {
  const season = await resolveSeasonStateInTx(tx, now)
  if (!season || season.status !== 'ACTIVE') {
    // The season closed while the army was on the road — no battle happens;
    // the detachment turns around (documented season-boundary rule).
    await startReturnLeg(
      tx,
      march,
      { x: territory.x, y: territory.y },
      now,
      committed,
      { aborted: 'SEASON_NOT_ACTIVE' },
      null,
      false,
    )
    return
  }

  const attacker = await tx.player.findUnique({
    where: { id: march.playerId },
    select: { id: true, name: true, level: true },
  })
  if (!attacker) throw new AppError('INTERNAL_ERROR', 'March owner vanished mid-processing')

  // ── Attacker side from the MARCH MANIFEST + real catalog (ONE builder) ──
  const catalogRows = await tx.unit.findMany({
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
  const catalog = catalogRows as unknown as Array<{
    id: string
    name: string
    class: string
    attack: number
    defense: number
    health: number
    speed: number
    strongAgainst: unknown
    weakAgainst: unknown
    carryCapacity: number
  }>
  const catalogById = new Map(catalog.map((row) => [row.id, row]))
  const stacks = []
  for (const stack of committed) {
    const unit = catalogById.get(stack.unitId)
    if (!unit) throw new AppError('INTERNAL_ERROR', `March unit ${stack.unitId} left the catalog`)
    stacks.push(toBattleStack(stack.count, unit))
  }
  const attackerArmy = {
    side: {
      playerId: attacker.id,
      name: attacker.name,
      stacks,
      modifiers: EMPTY_BPS,
      wallLevel: 0,
      hospitalBps: 0,
    } satisfies BattleSide,
    names: new Map<string, string>(catalog.map((row) => [row.id, row.name])),
  }

  // ── Defender side from CURRENT state (identical rules to direct assaults) ─
  // Owned territory: the POSITIONAL garrison defends when one exists
  // (Phase 34); otherwise the realm-wide army defends (Phase 33 contract).
  // Unclaimed: the deterministic virtual garrison (unchanged).
  let defenderSide: { side: BattleSide; totalCount: number; names: Map<string, string> }
  let defenderPlayerId: string | null = null
  let defenderPlayerName: string | null = null
  let defenderWasReal = false
  // Positional garrison contributions defending this territory (Phase 34) —
  // non-null routes defender casualties to the garrison, not player_units.
  let marchDefenderGarrison: GarrisonContributionManifest[] | null = null

  if (territory.ownerPlayerId !== null) {
    defenderWasReal = true
    defenderPlayerId = territory.ownerPlayerId
    const owner = await tx.player.findUnique({
      where: { id: territory.ownerPlayerId },
      select: { id: true, name: true, user: { select: { isBanned: true } } },
    })
    if (!owner || owner.user.isBanned) {
      // Owner vanished/banned mid-flight — no battle vs an invalid target.
      await startReturnLeg(
        tx,
        march,
        { x: territory.x, y: territory.y },
        now,
        committed,
        { aborted: 'TARGET_UNAVAILABLE' },
        null,
        false,
      )
      return
    }
    defenderPlayerName = owner.name
    const positional = await loadGarrisonDefenseInTx(tx, territory.id)
    if (positional) {
      // Positional defense: garrison stacks stand; their losses settle
      // against the CONTRIBUTIONS (not player_units) inside the shared
      // assault pipeline via defender.garrison.
      defenderSide = {
        side: {
          playerId: owner.id,
          name: owner.name,
          stacks: positional.stacks,
          modifiers: terrainDefenseModifiers(territory.terrain),
          wallLevel: 0,
          hospitalBps: 0,
        },
        totalCount: positional.totalCount,
        names: positional.names,
      }
      marchDefenderGarrison = positional.manifests
    } else {
      defenderSide = await loadArmySide(
        tx,
        owner.id,
        owner.name,
        terrainDefenseModifiers(territory.terrain),
        0,
        BATTLE.casualties.defenderHospitalBps,
      )
    }
  } else {
    const garrisonCatalog = await loadGarrisonCatalog(tx)
    const garrisonStacks = garrisonFor(
      WORLD.seed,
      territory.x,
      territory.y,
      territory.strategicValue,
      garrisonCatalog,
    )
    if (garrisonStacks.length === 0) {
      throw new AppError('INTERNAL_ERROR', 'Virtual garrison resolved to an empty army')
    }
    defenderSide = {
      side: {
        playerId: GARRISON_PLAYER_ID,
        name: GARRISON_NAME,
        stacks: garrisonStacks,
        modifiers: terrainDefenseModifiers(territory.terrain),
        wallLevel: 0,
        hospitalBps: 0,
      },
      totalCount: garrisonStacks.reduce((sum, s) => sum + s.count, 0),
      names: new Map<string, string>(garrisonCatalog.map((row) => [row.id, row.name])),
    }
  }

  // ── Simulate (PURE — the existing simulator, never a second one) ────────
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
      attackerSurvivors: stacks.map((s) => ({ unitTypeId: s.unitTypeId, count: s.count })),
      defenderSurvivors: [],
      defenderHospitalized: [],
      loot: {},
      honorDelta: 0,
      reputationDelta: 0,
      attackerPower: stacks.reduce(
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
        type: 'TERRITORY_ASSAULT' as BattleType,
        terrain: territory.terrain as TerrainType,
        coordinate: { x: territory.x, y: territory.y },
      },
    })
  }

  const resolution = await resolveTerritoryAssaultInTx({
    tx,
    now,
    seasonNumber: season.number,
    attacker: { playerId: attacker.id, name: attacker.name, level: attacker.level },
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
      regionId: territory.regionId,
    },
    defender: {
      side: defenderSide.side,
      names: defenderSide.names,
      playerId: defenderPlayerId,
      name: defenderPlayerName,
      wasReal: defenderWasReal,
      garrison: marchDefenderGarrison,
    },
    seed,
    unguarded,
    sim,
    marchId: march.id,
    energySpent: marchEnergyCost('ATTACK'),
    attackerUnitsInTransit: true,
  })

  // ── Survivors manifest (the ONLY settlement for in-transit units) ───────
  const survivors = subtractStacks(committed, sim.attackerLosses)
  if (survivors.length === 0) {
    // Every committed unit died — terminal LOST (nothing returns).
    await tx.march.update({
      where: { id: march.id },
      data: {
        status: 'LOST',
        completedAt: now,
        battleId: resolution.battleId,
        outcome: {
          battleId: resolution.battleId,
          result: sim.result,
          captured: resolution.captured,
          unitsLost: totalUnits(committed),
          destinationCoord: { x: territory.x, y: territory.y },
        } as unknown as Prisma.InputJsonValue,
      },
    })
    log.info('march lost', { marchId: march.id, playerId: march.playerId })
    return
  }

  await startReturnLeg(
    tx,
    march,
    { x: territory.x, y: territory.y },
    now,
    survivors,
    {
      battleId: resolution.battleId,
      result: sim.result,
      captured: resolution.captured,
      unitsLost: totalUnits(committed) - totalUnits(survivors),
      destinationCoord: { x: territory.x, y: territory.y },
    },
    resolution.battleId,
    sim.result === 'ATTACKER_WIN',
  )
}

/**
 * Starts the RETURNING leg: computes the deterministic homecoming time from
 * the SURVIVING composition over the same Manhattan distance and writes the
 * survivors manifest exactly once. `won` feeds the marchBattlesWon stat.
 */
async function startReturnLeg(
  tx: Tx,
  march: {
    id: string
    playerId: string
    type: string
    originX: number
    originY: number
  },
  destination: { x: number; y: number },
  now: Date,
  survivors: readonly MarchStack[],
  outcome: MarchOutcomeView,
  battleId: string | null,
  won: boolean,
): Promise<void> {
  const catalogSpeeds = await loadCatalogSpeeds(tx)
  const returnSeconds = marchTravelSeconds({
    // The road home is the SAME Manhattan distance the army just marched.
    distance: manhattanDistance({ x: march.originX, y: march.originY }, destination),
    armySpeed: slowestArmySpeed(survivors, catalogSpeeds),
    destinationTerrain: 'CITY', // the origin cell (the capital) is CITY terrain
  })
  const returnsAt = new Date(now.getTime() + returnSeconds * 1000)
  await tx.march.update({
    where: { id: march.id },
    data: {
      status: 'RETURNING',
      returnsAt,
      survivors: survivors as unknown as Prisma.InputJsonValue,
      battleId,
      outcome: outcome as unknown as Prisma.InputJsonValue,
    },
  })
  if (won) {
    await recordPlayerStats(tx, march.playerId, { marchBattlesWon: 1 })
  }
  log.info('march returning', {
    marchId: march.id,
    playerId: march.playerId,
    returnsAt: returnsAt.toISOString(),
    survivors: totalUnits(survivors),
  })
}

// ── Homecoming ───────────────────────────────────────────────────────────────

/**
 * The homecoming transaction: RETURNING → RESOLVING (exactly-once claim) →
 * COMPLETED. Survivors are restored to player_units EXACTLY once — a second
 * processor's claim hits 0 rows; the manifest cannot be applied twice.
 */
export async function processReturnInTx(tx: Tx, marchId: string, now: Date): Promise<boolean> {
  const claim = await tx.march.updateMany({
    where: { id: marchId, status: 'RETURNING', returnsAt: { lte: now } },
    data: { status: 'RESOLVING' },
  })
  if (claim.count === 0) return false // not due, or another processor won

  const march = await tx.march.findUnique({ where: { id: marchId } })
  if (!march) throw new AppError('INTERNAL_ERROR', `March ${marchId} vanished mid-processing`)

  const survivors = march.survivors === null ? [] : readStoredStacks(march.survivors)
  await restoreStacks(tx, march.playerId, survivors)

  const lostUnits = totalUnits(readStoredStacks(march.units)) - totalUnits(survivors)
  const outcome = outcomeView(march.outcome)
  await tx.march.update({
    where: { id: marchId },
    data: {
      status: 'COMPLETED',
      completedAt: now,
      outcome: {
        ...(outcome ?? {}),
        unitsReturned: totalUnits(survivors),
        unitsLost: lostUnits > 0 ? lostUnits : 0,
      } as unknown as Prisma.InputJsonValue,
    },
  })

  await recordPlayerStats(tx, march.playerId, { marchesCompleted: 1 })
  await applyQuestEventInTx(
    tx,
    march.playerId,
    {
      kind: 'MARCH_COMPLETED',
      marchId,
      action: march.type as 'ATTACK' | 'DEFEND' | 'SCOUT' | 'REINFORCE',
    },
    now,
  )
  await evaluateAchievementsInTx(tx, march.playerId, {}, now)

  await enqueueNotificationInTx(tx, {
    playerId: march.playerId,
    type: 'MARCH_RETURNED',
    dedupeKey: notificationDedupeKeys.marchReturned(marchId),
    payload: {
      marchId,
      action: march.type as 'ATTACK' | 'DEFEND' | 'SCOUT' | 'REINFORCE',
      unitsReturned: totalUnits(survivors),
      unitsLost: lostUnits > 0 ? lostUnits : 0,
      destinationCoord: outcome?.destinationCoord ?? {
        x: march.originX,
        y: march.originY,
      },
    },
  })

  log.info('march completed', {
    marchId,
    playerId: march.playerId,
    unitsReturned: totalUnits(survivors),
    unitsLost: lostUnits,
  })
  return true
}
