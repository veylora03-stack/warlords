/**
 * WARLORDS — City & Building service (Phase 6: City & Building System).
 *
 * THE single server-side write path for city construction. Upgrades debit
 * resources through the economy service (reason: BUILDING_UPGRADE) INSIDE
 * the same per-player serialized transaction that records the construction
 * state — a cost paid without a construction recorded (or the reverse) is
 * structurally impossible.
 *
 * Invariants (all enforced here, verified by tests):
 *  - NEVER TRUST THE CLIENT — the building type, target level, cost,
 *    duration and requirements all come from the server catalog; the client
 *    supplies only a type name. Every requirement is evaluated against real
 *    DB state inside the transaction.
 *  - NO DOUBLE-SPENDING — the per-player wallet mutex serializes upgrades;
 *    the cost is debited with the economy service's validate-ALL-then-write
 *    + conditional compare-and-decrement; the construction state is claimed
 *    with a conditional UPDATE guarded on isConstructing=false. A queue slot
 *    is checked under the same lock, so concurrent starters converge to at
 *    most `queueSlots` active constructions and at most one per building.
 *  - TRANSACTIONAL — wallet writes, ledger appends, construction state,
 *    completion notification and the power recalculation all share one
 *    transaction; any failure rolls back everything.
 *  - LEDGER-DRIVEN COSTS — every upgrade cost crosses the ledger with
 *    reason BUILDING_UPGRADE and a polymorphic ref to the building row.
 *
 * Construction lifecycle (recorded on the Building row — the Phase 2 schema
 * deliberately carries start/finish/status fields):
 *    IDLE → (start upgrade: cost debited, timer set) → CONSTRUCTING
 *         → (server clock ≥ upgradeCompletesAt) → COMPLETABLE
 *         → (finish claim: level applied, power recalculated) → IDLE
 */

import { db } from '@/lib/db'
import { AppError, errors } from '@/lib/api/errors'
import { logger } from '@/lib/logger'
import { BUILDING_TYPES, type BuildingType, type Resource } from '@/lib/game/types/common'
import type { EconomyResource } from '@/lib/game/config/economy'
import {
  CITY_BUILDING_ORDER,
  constructionQueueSlots,
  effectsFor,
  getBuildingDef,
  isBuildingType,
  materializeBuildingCatalog,
  upgradeCostFor,
  upgradeDurationSecFor,
  upgradeRequirementsFor,
  type BuildingEffects,
  type BuildingRequirements,
} from '@/lib/game/config/buildings'
import {
  ECONOMY_RESOURCES,
  runEconomyTransaction,
  spendResources,
} from '@/lib/game/services/economy.service'
import { recalculatePlayerPower } from '@/lib/game/services/power.service'
import { awardSeasonPointsInTx } from '@/lib/game/services/season.service'
import { seasonPointsForBuildingLevelUp } from '@/lib/game/config/seasons'
import type { Tx } from '@/lib/game/services/player-bootstrap.service'

const log = logger.child({ module: 'game/city' })

type ReadClient = Tx | typeof db

// ── Construction status (derived — no extra storage) ─────────────────────────

export type ConstructionStatus = 'IDLE' | 'CONSTRUCTING' | 'COMPLETABLE'

/** Minimal structural shape needed to derive the construction status. */
interface ConstructionTimerFields {
  isConstructing: boolean
  upgradeCompletesAt: Date | null
  pendingLevel: number | null
}

export function constructionStatus(
  building: ConstructionTimerFields,
  now: Date,
): ConstructionStatus {
  if (!building.isConstructing) return 'IDLE'
  if (
    building.pendingLevel !== null &&
    building.upgradeCompletesAt !== null &&
    building.upgradeCompletesAt.getTime() <= now.getTime()
  ) {
    return 'COMPLETABLE'
  }
  return 'CONSTRUCTING'
}

// ── Requirement evaluation (server-side truth) ───────────────────────────────

export interface CityStateSnapshot {
  townHallLevel: number
  playerLevel: number
  buildings: Map<BuildingType, number>
}

export interface UnmetRequirement {
  kind: 'TOWN_HALL' | 'PLAYER_LEVEL' | 'BUILDING'
  /** Human-readable reason — safe to expose (config values only). */
  reason: string
}

/** Pure evaluator: which of the requirements are unmet given real city state. */
export function evaluateRequirements(
  requirements: BuildingRequirements,
  snapshot: CityStateSnapshot,
): UnmetRequirement[] {
  const unmet: UnmetRequirement[] = []
  if (
    requirements.townHallLevel !== undefined &&
    snapshot.townHallLevel < requirements.townHallLevel
  ) {
    unmet.push({
      kind: 'TOWN_HALL',
      reason: `Town Hall level ${requirements.townHallLevel} required (have ${snapshot.townHallLevel})`,
    })
  }
  if (requirements.playerLevel !== undefined && snapshot.playerLevel < requirements.playerLevel) {
    unmet.push({
      kind: 'PLAYER_LEVEL',
      reason: `Player level ${requirements.playerLevel} required (have ${snapshot.playerLevel})`,
    })
  }
  for (const [type, level] of Object.entries(requirements.buildings ?? {}) as Array<
    [BuildingType, number]
  >) {
    const have = snapshot.buildings.get(type) ?? 0
    if (have < level) {
      unmet.push({
        kind: 'BUILDING',
        reason: `${getBuildingDef(type).name} level ${level} required (have ${have})`,
      })
    }
  }
  return unmet
}

// ── Internal readers ─────────────────────────────────────────────────────────

function unknownBuildingType(type: string): AppError {
  return new AppError(
    'BUILDING_NOT_FOUND',
    `Unknown building type: ${String(type)} — expected one of ${BUILDING_TYPES.join(', ')}`,
  )
}

async function loadCity(tx: ReadClient, playerId: string) {
  const city = await tx.city.findUnique({ where: { playerId } })
  if (!city) throw new AppError('NOT_FOUND', 'Player has no city')
  return city
}

async function loadBuildingRow(tx: ReadClient, cityId: string, type: BuildingType) {
  const building = await tx.building.findUnique({
    where: { cityId_type: { cityId, type } },
  })
  if (!building) {
    throw new AppError(
      'BUILDING_NOT_FOUND',
      `No ${type} building in this city — expected one of: ${BUILDING_TYPES.join(', ')}`,
    )
  }
  return building
}

async function loadCitySnapshot(tx: Tx, playerId: string): Promise<CityStateSnapshot> {
  const [rows, player] = await Promise.all([
    tx.building.findMany({
      where: { city: { playerId } },
      select: { type: true, level: true },
    }),
    tx.player.findUnique({ where: { id: playerId }, select: { level: true } }),
  ])
  if (!player) throw errors.notFoundPlayer()
  const buildings = new Map<BuildingType, number>()
  for (const row of rows) {
    if (isBuildingType(row.type)) buildings.set(row.type, row.level)
  }
  return {
    townHallLevel: buildings.get('TOWN_HALL') ?? 0,
    playerLevel: player.level,
    buildings,
  }
}

/** Typed BigInt cost map from the config catalog (server-side values only). */
function costToBigIntMap(
  cost: Partial<Record<Resource, number>>,
): Partial<Record<EconomyResource, bigint>> {
  const amounts: Partial<Record<EconomyResource, bigint>> = {}
  for (const [resource, amount] of Object.entries(cost) as Array<[Resource, number]>) {
    if (!Number.isInteger(amount) || amount <= 0) {
      // Config bug guard — never client-reachable: catalog amounts are integers.
      throw new AppError('INTERNAL_ERROR', `Invalid catalog cost for ${resource}: ${amount}`)
    }
    amounts[resource as EconomyResource] = BigInt(amount)
  }
  return amounts
}

// ── Mutations ────────────────────────────────────────────────────────────────

export interface BuildingUpgradeResult {
  building: BuildingView
  /** Balances AFTER the cost debit (display strings). */
  balances: Record<EconomyResource, string>
}

/**
 * Starts an upgrade: validates type/level/requirements/queue, debits the
 * cost through the ledger, and records the construction timer — all inside
 * ONE per-player serialized transaction. Any refusal leaves zero writes.
 *
 * Tx-scoped core: composes with a caller-owned transaction (the rollback
 * proof and future multi-action flows rely on this); the standalone wrapper
 * below owns the per-player wallet mutex.
 */
export async function startBuildingUpgradeInTx(
  tx: Tx,
  playerId: string,
  type: BuildingType,
): Promise<BuildingUpgradeResult> {
  const city = await loadCity(tx, playerId)
  const building = await loadBuildingRow(tx, city.id, type)
  const def = getBuildingDef(type)

  if (building.isConstructing) {
    throw new AppError('CONSTRUCTION_IN_PROGRESS', `${def.name} is already under construction`, {
      pendingLevel: building.pendingLevel,
      completesAt: building.upgradeCompletesAt?.toISOString() ?? null,
    })
  }

  const targetLevel = building.level + 1
  if (targetLevel > def.maxLevel) {
    throw new AppError('MAX_LEVEL_REACHED', `${def.name} is already at max level (${def.maxLevel})`)
  }

  // Requirements — evaluated from REAL state inside the tx.
  const snapshot = await loadCitySnapshot(tx, playerId)
  const requirements = upgradeRequirementsFor(type, targetLevel)
  const unmet = evaluateRequirements(requirements, snapshot)
  if (unmet.length > 0) {
    throw new AppError(
      'PREREQUISITE_MISSING',
      `${def.name} level ${targetLevel} requirements not met`,
      { missing: unmet.map((u) => u.reason) },
    )
  }

  // Queue capacity — Town Hall level decides the slot count.
  const activeCount = await tx.building.count({
    where: { cityId: city.id, isConstructing: true },
  })
  const slots = constructionQueueSlots(snapshot.townHallLevel)
  if (activeCount >= slots) {
    throw new AppError(
      'BUILDING_QUEUE_BUSY',
      `Construction queue is full (${activeCount}/${slots}) — finish a construction first`,
      { activeCount, slots },
    )
  }

  // Cost — debited through the economy service (ledger + conditional
  // decrement in this same tx). Insufficient funds → typed 409, no writes.
  const cost = upgradeCostFor(type, targetLevel)
  await spendResources(tx, playerId, costToBigIntMap(cost), {
    reason: 'BUILDING_UPGRADE',
    refType: 'building',
    refId: building.id,
    metadata: {
      buildingType: type,
      fromLevel: building.level,
      toLevel: targetLevel,
      durationSec: upgradeDurationSecFor(type, targetLevel),
    },
  })

  // Construction claim — conditional on still-idle (mutex backstop).
  const now = new Date()
  const completesAt = new Date(now.getTime() + upgradeDurationSecFor(type, targetLevel) * 1000)
  const claim = await tx.building.updateMany({
    where: { id: building.id, isConstructing: false },
    data: {
      isConstructing: true,
      upgradeStartedAt: now,
      upgradeCompletesAt: completesAt,
      pendingLevel: targetLevel,
    },
  })
  if (claim.count === 0) {
    // Unreachable behind the wallet mutex — defensive backstop.
    throw new AppError('CONSTRUCTION_IN_PROGRESS', `${def.name} was claimed concurrently`)
  }

  log.info('building upgrade started', {
    playerId,
    buildingType: type,
    fromLevel: building.level,
    toLevel: targetLevel,
    completesAt: completesAt.toISOString(),
  })

  // Re-read so the returned view reflects the CONSTRUCTING state just claimed.
  const updated = await loadBuildingRow(tx, city.id, type)
  const balances = await getBalanceView(tx, playerId)
  return { building: toBuildingView(updated, now), balances }
}

/** Standalone upgrade: per-player wallet mutex + retry + transaction. */
export async function startBuildingUpgrade(
  playerId: string,
  type: string,
): Promise<BuildingUpgradeResult> {
  if (!isBuildingType(type)) {
    throw unknownBuildingType(type)
  }
  return runEconomyTransaction(playerId, (tx) => startBuildingUpgradeInTx(tx, playerId, type))
}

export interface BuildingFinishResult {
  building: BuildingView
  /** Freshly recomputed total power (the level-up effect is live). */
  power: number
  newLevel: number
  /** Seasonal points awarded by THIS claim (0 outside an ACTIVE season). */
  seasonPoints: number
}

/**
 * Claims a finished construction. The server clock is the only authority on
 * timing; the level application is a conditional update guarded on
 * isConstructing=true, then power is recalculated from real state — all in
 * the caller's serialized transaction.
 */
export async function finishBuildingUpgradeInTx(
  tx: Tx,
  playerId: string,
  type: BuildingType,
): Promise<BuildingFinishResult> {
  const city = await loadCity(tx, playerId)
  const building = await loadBuildingRow(tx, city.id, type)
  const def = getBuildingDef(type)
  const now = new Date()

  if (
    !building.isConstructing ||
    building.pendingLevel === null ||
    building.upgradeCompletesAt === null
  ) {
    throw new AppError('CONSTRUCTION_NOT_ACTIVE', `${def.name} has no construction to claim`)
  }

  if (building.upgradeCompletesAt.getTime() > now.getTime()) {
    const remainingSec = Math.ceil((building.upgradeCompletesAt.getTime() - now.getTime()) / 1000)
    throw new AppError(
      'CONSTRUCTION_NOT_COMPLETE',
      `${def.name} construction is not finished yet — ${remainingSec}s remaining`,
      { completesAt: building.upgradeCompletesAt.toISOString(), remainingSec },
    )
  }

  const newLevel = building.pendingLevel
  const applied = await tx.building.updateMany({
    where: { id: building.id, isConstructing: true, pendingLevel: newLevel },
    data: {
      level: newLevel,
      isConstructing: false,
      upgradeStartedAt: null,
      upgradeCompletesAt: null,
      pendingLevel: null,
    },
  })
  if (applied.count === 0) {
    throw new AppError('CONSTRUCTION_NOT_ACTIVE', `${def.name} construction was already claimed`)
  }

  // The level-up effect is live immediately: power is recomputed from the
  // real state just mutated (never hand-set).
  const power = await recalculatePlayerPower(tx, playerId)

  // Seasonal score: server-computed from the real action inside the same tx.
  const seasonPoints = await awardSeasonPointsInTx(
    tx,
    playerId,
    seasonPointsForBuildingLevelUp(newLevel),
    'BUILDING_LEVEL_UP',
    { buildingType: type, newLevel },
  )

  await tx.notification.create({
    data: {
      playerId,
      type: 'CONSTRUCTION_COMPLETE',
      title: `${def.name} upgraded`,
      body: `${def.name} reached level ${newLevel}.`,
    },
  })

  log.info('building upgrade completed', {
    playerId,
    buildingType: type,
    newLevel,
    power,
    seasonPoints,
  })

  const updated = await loadBuildingRow(tx, city.id, type)
  return {
    building: toBuildingView(updated, now),
    power,
    newLevel,
    seasonPoints,
  }
}

/** Standalone finish claim: per-player wallet mutex + retry + transaction. */
export async function finishBuildingUpgrade(
  playerId: string,
  type: string,
): Promise<BuildingFinishResult> {
  if (!isBuildingType(type)) {
    throw unknownBuildingType(type)
  }
  return runEconomyTransaction(playerId, (tx) => finishBuildingUpgradeInTx(tx, playerId, type))
}

// ── Read models (API surface) ────────────────────────────────────────────────

export interface BuildingNextUpgrade {
  toLevel: number
  /** Cost in display strings (BigInt policy). */
  cost: Partial<Record<string, string>>
  durationSec: number
  /** Requirements as materialized config data. */
  requirements: BuildingRequirements
  /** Server-evaluated: true when ALL requirements are met right now. */
  requirementsMet: boolean
  /** Human-readable unmet reasons (empty when met). */
  unmetRequirements: string[]
}

export interface BuildingView {
  id: string
  type: BuildingType
  name: string
  category: string
  level: number
  maxLevel: number
  status: ConstructionStatus
  isConstructing: boolean
  upgradeStartedAt: string | null
  upgradeCompletesAt: string | null
  pendingLevel: number | null
  /** Effects of the CURRENT level (server-computed). */
  effects: BuildingEffects
  /** Upgrade preview to level+1 — null at max level or while constructing. */
  nextUpgrade: BuildingNextUpgrade | null
}

export interface CityProductionView {
  GOLD: number
  WOOD: number
  IRON: number
  FOOD: number
}

export interface CityView {
  city: { id: string; name: string; x: number; y: number }
  buildings: BuildingView[]
  production: CityProductionView
  storage: { capacity: number }
  construction: { activeCount: number; queueSlots: number }
  updatedAt: string
}

/** Minimal structural shape for building views (select-projection compatible). */
interface BuildingRowLike extends ConstructionTimerFields {
  id: string
  type: string
  level: number
  isConstructing: boolean
  upgradeStartedAt: Date | null
}

function toBuildingView(building: BuildingRowLike, now: Date): BuildingView {
  const def = getBuildingDef(building.type as BuildingType)
  const status = constructionStatus(building, now)
  const effects = effectsFor(def.type, building.level)

  let nextUpgrade: BuildingNextUpgrade | null = null
  const targetLevel = building.level + 1
  if (!building.isConstructing && targetLevel <= def.maxLevel) {
    const cost = upgradeCostFor(def.type, targetLevel)
    const stringCost: Partial<Record<string, string>> = {}
    for (const [resource, amount] of Object.entries(cost)) {
      stringCost[resource] = String(amount)
    }
    nextUpgrade = {
      toLevel: targetLevel,
      cost: stringCost,
      durationSec: upgradeDurationSecFor(def.type, targetLevel),
      requirements: upgradeRequirementsFor(def.type, targetLevel),
      requirementsMet: false, // filled by the city view where snapshot exists
      unmetRequirements: [],
    }
  }

  return {
    id: building.id,
    type: def.type,
    name: def.name,
    category: def.category,
    level: building.level,
    maxLevel: def.maxLevel,
    status,
    isConstructing: building.isConstructing,
    upgradeStartedAt: building.upgradeStartedAt?.toISOString() ?? null,
    upgradeCompletesAt: building.upgradeCompletesAt?.toISOString() ?? null,
    pendingLevel: building.pendingLevel,
    effects,
    nextUpgrade,
  }
}

function sumProduction(
  buildings: Array<{ type: BuildingType; level: number }>,
): CityProductionView {
  const production: CityProductionView = { GOLD: 0, WOOD: 0, IRON: 0, FOOD: 0 }
  for (const building of buildings) {
    const perHour = effectsFor(building.type, building.level).productionPerHour
    if (!perHour) continue
    production.GOLD += perHour.GOLD ?? 0
    production.WOOD += perHour.WOOD ?? 0
    production.IRON += perHour.IRON ?? 0
    production.FOOD += perHour.FOOD ?? 0
  }
  return production
}

function storageCapacity(buildings: Array<{ type: BuildingType; level: number }>): number {
  let capacity = 0
  for (const building of buildings) {
    const value = effectsFor(building.type, building.level).storageCapacity
    if (value !== undefined) capacity = Math.max(capacity, value)
  }
  return capacity
}

/**
 * Server-owned city projection: construction timers, per-building effects
 * and the aggregate production/storage/queue state — all computed from real
 * DB rows, never client input.
 */
export async function getCityView(client: ReadClient, playerId: string): Promise<CityView> {
  const city = await loadCity(client, playerId)
  const [rows, player] = await Promise.all([
    client.building.findMany({
      where: { cityId: city.id },
      select: {
        id: true,
        type: true,
        level: true,
        isConstructing: true,
        upgradeStartedAt: true,
        upgradeCompletesAt: true,
        pendingLevel: true,
        updatedAt: true,
      },
    }),
    client.player.findUnique({ where: { id: playerId }, select: { level: true } }),
  ])
  if (!player) throw errors.notFoundPlayer()

  const now = new Date()
  const snapshot: CityStateSnapshot = {
    townHallLevel: rows.find((r) => r.type === 'TOWN_HALL')?.level ?? 0,
    playerLevel: player.level,
    buildings: new Map(rows.map((r) => [r.type as BuildingType, r.level])),
  }
  const queueSlots = constructionQueueSlots(snapshot.townHallLevel)

  // Deterministic catalog order; long lists scroll in the UI.
  rows.sort((a, b) => {
    const ia = CITY_BUILDING_ORDER.indexOf(a.type as BuildingType)
    const ib = CITY_BUILDING_ORDER.indexOf(b.type as BuildingType)
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
  })

  const buildings = rows.map((row) => {
    const view = toBuildingView(row, now)
    if (view.nextUpgrade) {
      const requirements = upgradeRequirementsFor(view.type, view.nextUpgrade.toLevel)
      const unmet = evaluateRequirements(requirements, snapshot)
      view.nextUpgrade.requirementsMet = unmet.length === 0
      view.nextUpgrade.unmetRequirements = unmet.map((u) => u.reason)
    }
    return view
  })

  const levels = rows.map((r) => ({ type: r.type as BuildingType, level: r.level }))

  return {
    city: { id: city.id, name: city.name, x: city.x, y: city.y },
    buildings,
    production: sumProduction(levels),
    storage: { capacity: storageCapacity(levels) },
    construction: {
      activeCount: rows.filter((r) => r.isConstructing).length,
      queueSlots,
    },
    updatedAt: city.updatedAt.toISOString(),
  }
}

export interface CatalogLevelView {
  level: number
  /** Cost in display strings (BigInt policy — amounts never cross as numbers). */
  cost: Partial<Record<string, string>>
  durationSec: number
  requirements: BuildingRequirements
  effects: BuildingEffects
}

export interface CatalogTypeView {
  type: BuildingType
  name: string
  category: string
  description: string
  maxLevel: number
  levels: CatalogLevelView[]
}

export interface BuildingCatalogView {
  types: CatalogTypeView[]
}

/**
 * Full materialized catalog (17 types × per-level cost/duration/requirements/
 * effects) — pure config projection so the client renders exact numbers
 * without authority math. Costs cross as display strings (BigInt policy).
 */
export async function getBuildingCatalogView(): Promise<BuildingCatalogView> {
  const types = materializeBuildingCatalog().map((entry) => ({
    type: entry.type,
    name: entry.name,
    category: entry.category,
    description: entry.description,
    maxLevel: entry.maxLevel,
    levels: entry.levels.map((level) => ({
      level: level.level,
      cost: Object.fromEntries(
        Object.entries(level.cost).map(([resource, amount]) => [resource, String(amount)]),
      ),
      durationSec: level.durationSec,
      requirements: level.requirements,
      effects: level.effects,
    })),
  }))
  return { types }
}

// ── Balance helper (shared with the economy view shape) ──────────────────────

async function getBalanceView(tx: Tx, playerId: string): Promise<Record<EconomyResource, string>> {
  const wallet = await tx.resourceWallet.findUnique({ where: { playerId } })
  const player = await tx.player.findUnique({ where: { id: playerId }, select: { gems: true } })
  if (!wallet || !player) throw new AppError('INTERNAL_ERROR', 'Player wallet is missing')
  const stored: Record<EconomyResource, bigint> = {
    GOLD: wallet.gold,
    WOOD: wallet.wood,
    IRON: wallet.iron,
    FOOD: wallet.food,
    CRYSTAL: wallet.crystal,
    GEMS: player.gems,
  }
  return Object.fromEntries(
    ECONOMY_RESOURCES.map((key) => [key, stored[key].toString()]),
  ) as Record<EconomyResource, string>
}
