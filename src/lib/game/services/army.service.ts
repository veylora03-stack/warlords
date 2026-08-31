/**
 * WARLORDS — Army & Unit service (Phase 7: Army & Unit System).
 *
 * THE single server-side write path for the player's army. Recruitment debits
 * resources through the economy service (reason: UNIT_TRAINING) INSIDE the
 * same per-player serialized transaction that appends the queue item — a
 * cost paid without a queue item recorded (or the reverse) is structurally
 * impossible. Claimed batches mutate PlayerUnit counts; nothing else does:
 * the client can never set, push or adjust a unit count — it supplies ONLY
 * a unit id and a quantity, and every amount/duration/refund is resolved
 * from the server catalog and real DB state.
 *
 * Invariants (all enforced here, verified by tests):
 *  - NEVER TRUST THE CLIENT — the unit comes from the DB catalog (id must
 *    exist AND be active), the per-batch quantity ceiling and the queue
 *    depth come from config (ARMY_TRAINING), the cost/time from the catalog
 *    row, the speed from the training building's real level, and the
 *    required building level is evaluated against real DB rows in-tx.
 *  - NO DOUBLE-SPENDING — the per-player wallet mutex serializes every
 *    mutation; the cost is debited with the economy service's
 *    validate-ALL-then-write + conditional compare-and-decrement. Concurrent
 *    recruits converge on the FIFO chain; a queue overflow is a typed 409.
 *  - TRANSACTIONAL — wallet writes, ledger appends, queue rows, unit-count
 *    mutations, power recalculation and notifications share one transaction;
 *    any failure rolls back everything.
 *  - LEDGER-DRIVEN COSTS — every recruitment cost (and every cancellation
 *    refund) crosses the ledger with reason UNIT_TRAINING and a polymorphic
 *    ref to the queue item.
 *
 * Recruitment queue (FIFO, batch semantics — one row per recruited batch):
 *
 *   recruit → QUEUE item {count, startedAt, completesAt, status: TRAINING}
 *             chain: startedAt = max(now, tail.completesAt)
 *             window locked at enqueue (paid duration × count)
 *   claim   → (server clock ≥ completesAt) status DONE, PlayerUnit += count,
 *             power recalculated, TRAINING_COMPLETE notification
 *   cancel  → status CANCELLED, refund = paidCost × refundBps (policy:
 *             100% before the batch starts, 50% once training is under way),
 *             remaining queue re-walked so followers start as early as now
 *
 * The server clock is the ONLY timing authority — the client can never
 * shorten a window, claim early, or fabricate a completion.
 */

import { db } from '@/lib/db'
import { AppError, errors } from '@/lib/api/errors'
import { logger } from '@/lib/logger'
import { UNITS, UNIT_CLASS_ORDER } from '@/lib/game/config/units'
import { ARMY_TRAINING } from '@/lib/game/config/army'
import { getBuildingDef, effectsFor } from '@/lib/game/config/buildings'
import type { BuildingType, UnitClass } from '@/lib/game/types/common'
import type { EconomyResource } from '@/lib/game/config/economy'
import {
  ECONOMY_RESOURCES,
  grantResources,
  runEconomyTransaction,
  spendResources,
} from '@/lib/game/services/economy.service'
import { MAX_DELTA } from '@/lib/game/config/economy'
import { recalculatePlayerPower } from '@/lib/game/services/power.service'
import { awardSeasonPointsInTx } from '@/lib/game/services/season.service'
import { seasonPointsForTrainedUnits } from '@/lib/game/config/seasons'
import { enqueueNotificationInTx } from '@/lib/game/services/notification.service'
import { notificationDedupeKeys } from '@/lib/game/config/notifications'
import type { Tx } from '@/lib/game/services/player-bootstrap.service'

const log = logger.child({ module: 'game/army' })

type ReadClient = Tx | typeof db

const BPS = ARMY_TRAINING.bpsDenominator

// ── Queue status (derived — the stored status only knows TRAINING|DONE|CANCELLED) ──

export type QueueItemStatus = 'TRAINING' | 'COMPLETABLE' | 'DONE' | 'CANCELLED'

/** Minimal structural shape needed to derive the queue status. */
interface QueueTimerFields {
  status: string
  completesAt: Date
}

export function queueItemStatus(item: QueueTimerFields, now: Date): QueueItemStatus {
  if (item.status === 'DONE') return 'DONE'
  if (item.status === 'CANCELLED') return 'CANCELLED'
  if (item.completesAt.getTime() <= now.getTime()) return 'COMPLETABLE'
  return 'TRAINING'
}

// ── Internal readers & guards ────────────────────────────────────────────────

interface CatalogUnit {
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
  trainingCost: unknown
  trainingTimeSec: number
  trainingBuilding: string
  requiredBuildingLevel: number
  isActive: boolean
}

async function loadActiveUnit(tx: ReadClient, unitId: string): Promise<CatalogUnit> {
  const unit = await tx.unit.findUnique({ where: { id: unitId } })
  if (!unit || !unit.isActive) {
    // The roster lives in the DB catalog — anything else is a 404, never a
    // guess. Retired units are refused exactly like unknown ids.
    throw new AppError(
      'UNIT_NOT_FOUND',
      `Unknown unit: ${String(unitId)} — not in the active roster`,
    )
  }
  return unit as CatalogUnit
}

function assertBatchCount(count: number): void {
  if (!Number.isInteger(count) || count < 1) {
    throw new AppError('VALIDATION_ERROR', `Unit count must be a positive integer (got ${count})`)
  }
  if (count > ARMY_TRAINING.maxUnitsPerBatch) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Unit count exceeds the per-batch ceiling (${ARMY_TRAINING.maxUnitsPerBatch})`,
      { max: ARMY_TRAINING.maxUnitsPerBatch },
    )
  }
}

/** Validated BigInt cost map for `count` units (server catalog values only). */
function batchCost(unit: CatalogUnit, count: number): Partial<Record<EconomyResource, bigint>> {
  const raw = unit.trainingCost as Record<string, unknown> | null
  if (!raw || typeof raw !== 'object') {
    throw new AppError('INTERNAL_ERROR', `Unit ${unit.id} has a corrupt training cost catalog`)
  }
  const amounts: Partial<Record<EconomyResource, bigint>> = {}
  for (const [resource, base] of Object.entries(raw)) {
    if (!ECONOMY_RESOURCES.includes(resource as EconomyResource)) {
      throw new AppError(
        'INTERNAL_ERROR',
        `Unit ${unit.id} cost names unknown resource ${resource}`,
      )
    }
    if (typeof base !== 'number' || !Number.isInteger(base) || base <= 0) {
      throw new AppError(
        'INTERNAL_ERROR',
        `Unit ${unit.id} has invalid cost for ${resource}: ${String(base)}`,
      )
    }
    const total = BigInt(base) * BigInt(count)
    if (total > MAX_DELTA) {
      throw new AppError(
        'INVALID_AMOUNT',
        `Batch cost for ${resource} exceeds the mutation ceiling`,
      )
    }
    amounts[resource as EconomyResource] = total
  }
  if (Object.keys(amounts).length === 0) {
    throw new AppError('INTERNAL_ERROR', `Unit ${unit.id} has an empty training cost catalog`)
  }
  return amounts
}

/** Integer per-unit window (ms) at the training building's REAL speed. */
function perUnitMs(unit: CatalogUnit, buildingLevel: number): number {
  if (!Number.isInteger(unit.trainingTimeSec) || unit.trainingTimeSec < 1) {
    throw new AppError('INTERNAL_ERROR', `Unit ${unit.id} has invalid trainingTimeSec`)
  }
  const speedBps = effectsFor(unit.trainingBuilding as BuildingType, buildingLevel).trainingSpeedBps
  if (speedBps === undefined || speedBps <= 0) {
    throw new AppError(
      'INTERNAL_ERROR',
      `Building ${unit.trainingBuilding} lacks a positive trainingSpeedBps`,
    )
  }
  // Integer-only bps math: base ms × 10_000 / speedBps, floored.
  return Math.floor((unit.trainingTimeSec * 1000 * BPS) / speedBps)
}

async function loadTrainingBuilding(tx: ReadClient, playerId: string, type: string) {
  const city = await tx.city.findUnique({ where: { playerId }, select: { id: true } })
  if (!city) throw new AppError('NOT_FOUND', 'Player has no city')
  const building = await tx.building.findUnique({
    where: { cityId_type: { cityId: city.id, type } },
  })
  if (!building) {
    throw new AppError('BUILDING_NOT_FOUND', `No ${type} in this city — the unit cannot be trained`)
  }
  return building
}

async function loadOwnQueueItem(tx: ReadClient, playerId: string, itemId: string) {
  const item = await tx.trainingQueueItem.findFirst({
    where: { id: itemId, playerId },
    include: { unit: { select: { name: true, trainingCost: true, tier: true } } },
  })
  if (!item) {
    // Only the owner's rows are reachable — foreign ids are indistinguishable
    // from nonexistent ones (no existence oracle for other players' queues).
    throw new AppError('TRAINING_NOT_FOUND', 'Training queue item not found')
  }
  return item
}

/** FIFO active queue — the chain order (createdAt) is the authority. */
async function loadActiveQueue(tx: ReadClient, playerId: string) {
  return tx.trainingQueueItem.findMany({
    where: { playerId, status: 'TRAINING' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { unit: { select: { name: true } } },
  })
}

// ── Recruit ──────────────────────────────────────────────────────────────────

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

export interface RecruitResult {
  item: TrainingQueueItemView
  queue: TrainingQueueItemView[]
  /** Balances AFTER the cost debit (display strings). */
  balances: Record<EconomyResource, string>
}

async function balancesView(tx: Tx, playerId: string): Promise<Record<EconomyResource, string>> {
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

function toQueueItemView(
  item: {
    id: string
    unitId: string
    unit: { name: string }
    count: number
    status: string
    startedAt: Date
    completesAt: Date
  },
  now: Date,
): TrainingQueueItemView {
  const remainingMs = Math.max(0, item.completesAt.getTime() - now.getTime())
  return {
    id: item.id,
    unitId: item.unitId,
    unitName: item.unit.name,
    count: item.count,
    status: queueItemStatus(item, now),
    startedAt: item.startedAt.toISOString(),
    completesAt: item.completesAt.toISOString(),
    remainingSec: Math.ceil(remainingMs / 1000),
  }
}

async function queueView(
  tx: ReadClient,
  playerId: string,
  now: Date,
): Promise<TrainingQueueItemView[]> {
  const active = await loadActiveQueue(tx, playerId)
  return active.map((item) => toQueueItemView(item, now))
}

/**
 * Tx-scoped recruit: validates unit/quantity/building/queue, computes the
 * FIFO window at the building's real speed, debits the batch cost through
 * the ledger, and appends the queue item — all inside the caller's
 * transaction. Any refusal leaves zero writes.
 */
export async function recruitUnitsInTx(
  tx: Tx,
  playerId: string,
  unitId: string,
  count: number,
): Promise<RecruitResult> {
  assertBatchCount(count)
  const unit = await loadActiveUnit(tx, unitId)

  // Training building gate — evaluated from REAL state inside the tx.
  const building = await loadTrainingBuilding(tx, playerId, unit.trainingBuilding)
  if (building.level < unit.requiredBuildingLevel) {
    const def = getBuildingDef(unit.trainingBuilding as BuildingType)
    throw new AppError(
      'PREREQUISITE_MISSING',
      `${unit.name} requires ${def.name} level ${unit.requiredBuildingLevel} (have ${building.level})`,
      {
        missing: [
          `${def.name} level ${unit.requiredBuildingLevel} required (have ${building.level})`,
        ],
      },
    )
  }

  // Queue depth gate — one FIFO chain per player, config-driven depth.
  const active = await loadActiveQueue(tx, playerId)
  if (active.length >= ARMY_TRAINING.queueSlots) {
    throw new AppError(
      'TRAINING_QUEUE_FULL',
      `Training queue is full (${active.length}/${ARMY_TRAINING.queueSlots}) — claim or cancel an item first`,
      { activeCount: active.length, slots: ARMY_TRAINING.queueSlots },
    )
  }

  // FIFO chain: start as soon as the current tail completes (or now).
  const now = new Date()
  const tailCompletesAt = active.reduce(
    (latest, item) => (item.completesAt.getTime() > latest ? item.completesAt.getTime() : latest),
    0,
  )
  const startedAtMs = Math.max(now.getTime(), tailCompletesAt)
  const windowMs = perUnitMs(unit, building.level) * count
  if (windowMs <= 0 || !Number.isSafeInteger(windowMs)) {
    throw new AppError('INTERNAL_ERROR', 'Computed training window is invalid')
  }
  const completesAt = new Date(startedAtMs + windowMs)

  const created = await tx.trainingQueueItem.create({
    data: {
      playerId,
      unitId: unit.id,
      count,
      startedAt: new Date(startedAtMs),
      completesAt,
      status: 'TRAINING',
    },
    include: { unit: { select: { name: true } } },
  })

  // Cost — debited through the economy service (ledger + conditional
  // decrement in this same tx). Insufficient funds → typed 409, no writes.
  await spendResources(tx, playerId, batchCost(unit, count), {
    reason: 'UNIT_TRAINING',
    refType: 'training_queue',
    refId: created.id,
    metadata: {
      unitId: unit.id,
      unitName: unit.name,
      count,
      perUnitMs: windowMs / count,
      speedBps: effectsFor(unit.trainingBuilding as BuildingType, building.level).trainingSpeedBps,
      queuePosition: active.length + 1,
    },
  })

  log.info('units queued for training', {
    playerId,
    unitId: unit.id,
    count,
    queuePosition: active.length + 1,
    completesAt: completesAt.toISOString(),
  })

  const queue = await queueView(tx, playerId, now)
  return {
    item: toQueueItemView(created, now),
    queue,
    balances: await balancesView(tx, playerId),
  }
}

/** Standalone recruit: per-player wallet mutex + retry + transaction. */
export async function recruitUnits(
  playerId: string,
  unitId: string,
  count: number,
): Promise<RecruitResult> {
  if (typeof unitId !== 'string' || unitId.length === 0 || unitId.length > 64) {
    throw new AppError('VALIDATION_ERROR', 'unitId must be a 1…64 character string')
  }
  return runEconomyTransaction(playerId, (tx) => recruitUnitsInTx(tx, playerId, unitId, count))
}

// ── Completion (server-clock claim) ─────────────────────────────────────────

export interface TrainingCompleteResult {
  completed: { id: string; unitId: string; unitName: string; count: number }
  /** Freshly recomputed total power (the trained units are live). */
  power: number
  /** Seasonal points awarded by THIS claim (0 outside an ACTIVE season). */
  seasonPoints: number
  /** The player's total count of THE trained unit (starter + trained). */
  stackCount: number
  queue: TrainingQueueItemView[]
}

/**
 * Claims a finished batch. The server clock is the only authority on timing;
 * the claim is a conditional update guarded on status=TRAINING (a concurrent
 * cancel/claim loses the race with a typed 409), then the unit count lands
 * via upsert-increment and power is recalculated from real state.
 */
export async function completeTrainingInTx(
  tx: Tx,
  playerId: string,
  itemId: string,
): Promise<TrainingCompleteResult> {
  const item = await loadOwnQueueItem(tx, playerId, itemId)
  const now = new Date()

  if (item.status !== 'TRAINING') {
    throw new AppError('TRAINING_NOT_ACTIVE', 'Training item is already resolved')
  }
  if (item.completesAt.getTime() > now.getTime()) {
    const remainingSec = Math.ceil((item.completesAt.getTime() - now.getTime()) / 1000)
    throw new AppError(
      'TRAINING_NOT_COMPLETE',
      `${item.unit.name} batch is not finished yet — ${remainingSec}s remaining`,
      { completesAt: item.completesAt.toISOString(), remainingSec },
    )
  }

  const claim = await tx.trainingQueueItem.updateMany({
    where: { id: item.id, playerId, status: 'TRAINING' },
    data: { status: 'DONE' },
  })
  if (claim.count === 0) {
    // Unreachable behind the wallet mutex — defensive backstop.
    throw new AppError('TRAINING_NOT_ACTIVE', 'Training item was resolved concurrently')
  }

  const stack = await tx.playerUnit.upsert({
    where: { playerId_unitId: { playerId, unitId: item.unitId } },
    update: { count: { increment: item.count } },
    create: { playerId, unitId: item.unitId, count: item.count },
  })

  // The trained units are live immediately: power recomputed from real state.
  const power = await recalculatePlayerPower(tx, playerId)

  // Seasonal score: server-computed from the real action inside the same tx.
  const seasonPoints = await awardSeasonPointsInTx(
    tx,
    playerId,
    seasonPointsForTrainedUnits(item.unit.tier, item.count),
    'UNIT_TRAINED',
    { unitId: item.unitId, tier: item.unit.tier, count: item.count },
  )

  // Completion notice rides the notification engine's queue (Phase 22) —
  // keyed on the training batch id, so a replayed claim cannot re-notify.
  await enqueueNotificationInTx(tx, {
    playerId,
    type: 'TRAINING_COMPLETE',
    dedupeKey: notificationDedupeKeys.training(item.id),
    payload: {
      unitId: item.unitId,
      unitName: item.unit.name,
      count: item.count,
    },
  })

  log.info('training batch completed', {
    playerId,
    unitId: item.unitId,
    count: item.count,
    power,
    seasonPoints,
  })

  const queue = await queueView(tx, playerId, now)
  return {
    completed: {
      id: item.id,
      unitId: item.unitId,
      unitName: item.unit.name,
      count: item.count,
    },
    power,
    seasonPoints,
    stackCount: stack.count,
    queue,
  }
}

/** Standalone completion claim: per-player wallet mutex + retry + transaction. */
export async function completeTraining(
  playerId: string,
  itemId: string,
): Promise<TrainingCompleteResult> {
  if (typeof itemId !== 'string' || itemId.length === 0 || itemId.length > 64) {
    throw new AppError('VALIDATION_ERROR', 'Queue item id must be a 1…64 character string')
  }
  return runEconomyTransaction(playerId, (tx) => completeTrainingInTx(tx, playerId, itemId))
}

// ── Cancellation (policy refund + queue re-walk) ─────────────────────────────

export interface TrainingCancelResult {
  cancelled: {
    id: string
    unitId: string
    unitName: string
    count: number
    /** Was the batch already under way when cancelled? */
    wasStarted: boolean
    refundBps: number
  }
  /** Refunded amounts (display strings; clamped BigInt policy). */
  refund: Partial<Record<EconomyResource, string>>
  balances: Record<EconomyResource, string>
  queue: TrainingQueueItemView[]
}

/**
 * Cancels a TRAINING batch: policy-driven refund through the ledger, a
 * conditional status flip guarded on status=TRAINING, then the remaining
 * queue is re-walked so followers start as early as `now` (their paid
 * per-unit windows are preserved — durations never change, only anchors).
 */
export async function cancelTrainingInTx(
  tx: Tx,
  playerId: string,
  itemId: string,
): Promise<TrainingCancelResult> {
  const item = await loadOwnQueueItem(tx, playerId, itemId)
  const now = new Date()

  if (item.status !== 'TRAINING') {
    throw new AppError('TRAINING_NOT_ACTIVE', 'Training item is already resolved')
  }

  const wasStarted = item.startedAt.getTime() <= now.getTime()
  const refundBps = wasStarted
    ? ARMY_TRAINING.inProgressRefundBps
    : ARMY_TRAINING.notStartedRefundBps

  // Conditional cancel claim FIRST — the refund and re-walk below observe
  // the post-cancel queue (and the mutex backstop rejects losers).
  const claim = await tx.trainingQueueItem.updateMany({
    where: { id: item.id, playerId, status: 'TRAINING' },
    data: { status: 'CANCELLED' },
  })
  if (claim.count === 0) {
    throw new AppError('TRAINING_NOT_ACTIVE', 'Training item was resolved concurrently')
  }

  // Policy refund — floor(batchCost × refundBps / 10_000) per resource,
  // credited through the economy service (ledger reason UNIT_TRAINING).
  const raw = item.unit.trainingCost as Record<string, unknown> | null
  const refundAmounts: Partial<Record<EconomyResource, bigint>> = {}
  if (raw && typeof raw === 'object') {
    for (const [resource, base] of Object.entries(raw)) {
      if (!ECONOMY_RESOURCES.includes(resource as EconomyResource)) continue
      if (typeof base !== 'number' || !Number.isInteger(base) || base <= 0) continue
      const amount = (BigInt(base) * BigInt(item.count) * BigInt(refundBps)) / BigInt(BPS)
      if (amount > 0n) refundAmounts[resource as EconomyResource] = amount
    }
  }

  if (Object.keys(refundAmounts).length > 0) {
    await grantResources(tx, playerId, refundAmounts, {
      reason: 'UNIT_TRAINING',
      refType: 'training_queue',
      refId: item.id,
      metadata: {
        kind: 'cancel_refund',
        unitId: item.unitId,
        count: item.count,
        refundBps,
        wasStarted,
      },
    })
  }

  // Re-walk the remaining FIFO chain: already-started windows are immutable;
  // every not-yet-started item anchors as early as the cursor allows with
  // its PAID per-unit window (completesAt − startedAt is exactly window/count).
  const remaining = await loadActiveQueue(tx, playerId)
  let cursorMs = now.getTime()
  for (const it of remaining) {
    if (it.startedAt.getTime() <= now.getTime()) {
      cursorMs = Math.max(cursorMs, it.completesAt.getTime())
      continue
    }
    const windowMs = it.completesAt.getTime() - it.startedAt.getTime()
    const nextStart = cursorMs
    const nextComplete = nextStart + windowMs
    await tx.trainingQueueItem.update({
      where: { id: it.id },
      data: { startedAt: new Date(nextStart), completesAt: new Date(nextComplete) },
    })
    cursorMs = nextComplete
  }

  log.info('training batch cancelled', {
    playerId,
    unitId: item.unitId,
    count: item.count,
    refundBps,
    wasStarted,
  })

  const queue = await queueView(tx, playerId, now)
  const refund = Object.fromEntries(
    Object.entries(refundAmounts).map(([resource, amount]) => [resource, amount.toString()]),
  ) as Partial<Record<EconomyResource, string>>

  return {
    cancelled: {
      id: item.id,
      unitId: item.unitId,
      unitName: item.unit.name,
      count: item.count,
      wasStarted,
      refundBps,
    },
    refund,
    balances: await balancesView(tx, playerId),
    queue,
  }
}

/** Standalone cancellation: per-player wallet mutex + retry + transaction. */
export async function cancelTraining(
  playerId: string,
  itemId: string,
): Promise<TrainingCancelResult> {
  if (typeof itemId !== 'string' || itemId.length === 0 || itemId.length > 64) {
    throw new AppError('VALIDATION_ERROR', 'Queue item id must be a 1…64 character string')
  }
  return runEconomyTransaction(playerId, (tx) => cancelTrainingInTx(tx, playerId, itemId))
}

// ── Read models (API surface) ────────────────────────────────────────────────

export interface ArmyUnitStackView {
  unitId: string
  name: string
  class: UnitClass
  tier: number
  count: number
  attack: number
  defense: number
  health: number
  speed: number
  foodUpkeep: number
  carryCapacity: number
}

export interface ArmyTrainingView {
  queue: TrainingQueueItemView[]
  activeCount: number
  queueSlots: number
  /** Current training speed per camp, from the REAL building levels. */
  speedBps: Partial<Record<BuildingType, number>>
}

export interface ArmyView {
  units: ArmyUnitStackView[]
  totals: {
    /** Total trained units. */
    unitCount: number
    /** Total food upkeep per hour of the standing army. */
    upkeepFood: number
    /** Total loot capacity of the standing army. */
    carryCapacity: number
  }
  training: ArmyTrainingView
  updatedAt: string
}

/**
 * Server-owned army projection: the full active roster joined with the
 * player's real stacks (zero-count roster entries included so the client
 * renders one screen), aggregated upkeep/carry totals and the live training
 * queue — all computed from real DB rows, never client input.
 */
export async function getArmyView(client: ReadClient, playerId: string): Promise<ArmyView> {
  const player = await client.player.findUnique({ where: { id: playerId }, select: { id: true } })
  if (!player) throw errors.notFoundPlayer()

  const now = new Date()
  const [catalogUnits, stacks, city] = await Promise.all([
    client.unit.findMany({ where: { isActive: true } }),
    client.playerUnit.findMany({ where: { playerId } }),
    client.city.findUnique({
      where: { playerId },
      select: { id: true, updatedAt: true },
    }),
  ])

  const countByUnit = new Map(stacks.map((s) => [s.unitId, s.count]))

  const classRank = (cls: string): number => {
    const index = UNIT_CLASS_ORDER.indexOf(cls as UnitClass)
    return index === -1 ? 99 : index
  }
  const roster = catalogUnits
    .slice()
    .sort(
      (a, b) =>
        classRank(a.class) - classRank(b.class) || a.tier - b.tier || a.id.localeCompare(b.id),
    )

  let unitCount = 0
  let upkeepFood = 0
  let carryCapacity = 0
  const units: ArmyUnitStackView[] = roster.map((unit) => {
    const count = countByUnit.get(unit.id) ?? 0
    unitCount += count
    upkeepFood += count * unit.foodUpkeep
    carryCapacity += count * unit.carryCapacity
    return {
      unitId: unit.id,
      name: unit.name,
      class: unit.class as UnitClass,
      tier: unit.tier,
      count,
      attack: unit.attack,
      defense: unit.defense,
      health: unit.health,
      speed: unit.speed,
      foodUpkeep: unit.foodUpkeep,
      carryCapacity: unit.carryCapacity,
    }
  })

  // Training speed per camp — from the real building levels (display only;
  // the recruit path re-evaluates the same effects in-tx).
  const speedBps: Partial<Record<BuildingType, number>> = {}
  if (city) {
    const militaryBuildings = await client.building.findMany({
      where: { cityId: city.id, type: { in: ['BARRACKS', 'ARCHER_CAMP', 'STABLE', 'ARMORY'] } },
      select: { type: true, level: true },
    })
    for (const building of militaryBuildings) {
      const speed = effectsFor(building.type as BuildingType, building.level).trainingSpeedBps
      if (speed !== undefined) speedBps[building.type as BuildingType] = speed
    }
  }

  const queue = await queueView(client, playerId, now)

  return {
    units,
    totals: { unitCount, upkeepFood, carryCapacity },
    training: {
      queue,
      activeCount: queue.length,
      queueSlots: ARMY_TRAINING.queueSlots,
      speedBps,
    },
    updatedAt: (city?.updatedAt ?? now).toISOString(),
  }
}

// ── Catalog (config projection — mirrors getBuildingCatalogView) ─────────────

export interface CatalogUnitView {
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
  /** Per-unit training cost (display strings — BigInt policy). */
  trainingCost: Partial<Record<string, string>>
  trainingTimeSec: number
  trainingBuilding: BuildingType
  trainingBuildingName: string
  requiredBuildingLevel: number
  strongAgainst: Array<{ unitId: string; bonusBps: number }>
  weakAgainst: Array<{ unitId: string; penaltyBps: number }>
  description: string
}

export interface ArmyCatalogView {
  units: CatalogUnitView[]
}

interface ConfigUnitLike {
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
  trainingBuilding: BuildingType
  requiredBuildingLevel: number
  strongAgainst: Array<{ unitId: string; bonusBps: number }>
  weakAgainst: Array<{ unitId: string; penaltyBps: number }>
  description: string
}

/**
 * Full materialized unit catalog (roster × stats/cost/time/counters/building
 * gates) — pure config projection so the client renders exact numbers
 * without authority math. Costs cross as display strings (BigInt policy).
 *
 * Phase 25: MEMOIZED — pure function of static config, zero staleness risk;
 * the per-request rebuild was pure allocation churn on a hot read path.
 */
let armyCatalogCache: ArmyCatalogView | null = null
export function getArmyCatalogView(): ArmyCatalogView {
  if (armyCatalogCache) return armyCatalogCache
  const units = (UNITS as unknown as ConfigUnitLike[]).map((unit) => ({
    id: unit.id,
    name: unit.name,
    class: unit.class,
    tier: unit.tier,
    attack: unit.attack,
    defense: unit.defense,
    health: unit.health,
    speed: unit.speed,
    foodUpkeep: unit.foodUpkeep,
    carryCapacity: unit.carryCapacity,
    trainingCost: Object.fromEntries(
      Object.entries(unit.trainingCost).map(([resource, amount]) => [resource, String(amount)]),
    ),
    trainingTimeSec: unit.trainingTimeSec,
    trainingBuilding: unit.trainingBuilding,
    trainingBuildingName: getBuildingDef(unit.trainingBuilding).name,
    requiredBuildingLevel: unit.requiredBuildingLevel,
    strongAgainst: unit.strongAgainst,
    weakAgainst: unit.weakAgainst,
    description: unit.description,
  }))
  armyCatalogCache = { units }
  return armyCatalogCache
}
