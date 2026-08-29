/**
 * WARLORDS — Economy service (Phase 5: Resource & Economy Engine).
 *
 * THE single server-side write path for all six economy resources
 * (GOLD · WOOD · IRON · FOOD · CRYSTAL on ResourceWallet, GEMS on Player).
 * Future subsystems (quest claims, building upgrades, unit training, battle
 * resolution, market, admin tools) call the functions here INSIDE their own
 * transaction — the client can never submit an amount, a reason, or a target.
 *
 * Invariants (all enforced here, verified by tests):
 *  - NO NEGATIVE BALANCES — debits are validated against the current balance
 *    AND persisted through a conditional compare-and-decrement, so the
 *    balance can never go below zero even if the serialization layer were
 *    bypassed. Insufficient funds → typed 409, nothing is written.
 *  - OVERFLOW-SAFE — math is BigInt-only; credits clamp at the configured
 *    resource cap and the CLAMPED delta is what the ledger records, so
 *    `Σ(ledger delta) == stored balance` always reconciles.
 *  - EVERY DELTA HAS A REASON — mutations are rejected unless the reason is
 *    a member of the data-driven ledger catalog (config/economy.ts).
 *  - TRANSACTIONAL — wallet writes and ledger appends share the caller's
 *    transaction; any failure rolls back both (no phantom coins, no orphan
 *    ledger rows).
 *  - RACE-SAFE — standalone economy transactions serialize behind a
 *    per-player in-process mutex (FIFO) with bounded transient-retry;
 *    tx-embedded calls inherit the caller's serialization duty. The
 *    conditional debit guard above remains the DB-level backstop.
 *  - DUPLICATE-PROOF GRANTS — `grantResources` accepts an idempotency key
 *    persisted in the SAME transaction as the payout; a replay returns the
 *    original result instead of paying twice.
 *
 * NEVER TRUST THE CLIENT: every amount arrives from server code only; read
 * endpoints accept nothing beyond the authenticated player id.
 */

import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import { AppError, errors } from '@/lib/api/errors'
import { logger } from '@/lib/logger'
import { withKeyLock } from '@/lib/concurrency/mutex'
import { withWriteRetry } from './player-registration.service'
import type { Tx } from './player-bootstrap.service'
import {
  ECONOMY_HISTORY,
  ECONOMY_RESOURCES,
  GRANT_IDEMPOTENCY_TTL_SECONDS,
  LEDGER_REASONS,
  MAX_DELTA,
  RESOURCE_CAPS,
  creditWithCap,
  debitBalance,
  type EconomyResource,
  type LedgerReason,
} from '@/lib/game/config/economy'

const log = logger.child({ module: 'game/economy' })

type ReadClient = Tx | typeof db

// ── Storage resolution ───────────────────────────────────────────────────────

type WalletField = 'gold' | 'wood' | 'iron' | 'food' | 'crystal'

const WALLET_FIELD: Record<Exclude<EconomyResource, 'GEMS'>, WalletField> = {
  GOLD: 'gold',
  WOOD: 'wood',
  IRON: 'iron',
  FOOD: 'food',
  CRYSTAL: 'crystal',
}

const isWalletResource = (
  resource: EconomyResource,
): resource is Exclude<EconomyResource, 'GEMS'> => resource !== 'GEMS'

// ── Public types ─────────────────────────────────────────────────────────────

export interface ResourceDelta {
  resource: EconomyResource
  /** Signed amount — positive credits, negative debits. Never zero. */
  delta: bigint
}

export interface LedgerWriteMeta {
  reason: LedgerReason
  /** Polymorphic reference (e.g. "building", "quest", "market_order"). */
  refType?: string
  refId?: string
  metadata?: Prisma.InputJsonValue
}

export interface AppliedResourceDelta {
  resource: EconomyResource
  requestedDelta: bigint
  /** What was actually applied (≤ |requested|; 0 when fully capped). */
  appliedDelta: bigint
  balanceBefore: bigint
  balanceAfter: bigint
  capped: boolean
  /** True when a clamped credit applied zero — no write, no ledger row. */
  skipped: boolean
}

export interface GrantResult {
  applied: AppliedResourceDelta[]
  /** True when an idempotency key replay returned the ORIGINAL payout. */
  replayed: boolean
}

// ── Validation ───────────────────────────────────────────────────────────────

function assertEconomyResource(resource: unknown): asserts resource is EconomyResource {
  if (typeof resource !== 'string' || !ECONOMY_RESOURCES.includes(resource as EconomyResource)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Unknown resource: ${String(resource)} — expected one of ${ECONOMY_RESOURCES.join(', ')}`,
    )
  }
}

function assertDelta(resource: EconomyResource, delta: unknown): asserts delta is bigint {
  if (typeof delta !== 'bigint') {
    throw new AppError(
      'INVALID_AMOUNT',
      `Resource delta for ${resource} must be a BigInt amount (server-side values only)`,
    )
  }
  if (delta === 0n) {
    throw new AppError('INVALID_AMOUNT', `Resource delta for ${resource} must not be zero`)
  }
  if (delta > MAX_DELTA || delta < -MAX_DELTA) {
    throw new AppError(
      'INVALID_AMOUNT',
      `Resource delta for ${resource} exceeds the single-mutation ceiling (±${MAX_DELTA})`,
    )
  }
}

function assertReason(reason: unknown): asserts reason is LedgerReason {
  if (typeof reason !== 'string' || !LEDGER_REASONS.includes(reason as LedgerReason)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Unknown ledger reason: ${String(reason)} — expected one of ${LEDGER_REASONS.join(', ')}`,
    )
  }
}

/** Validates a delta list: known resources, valid BigInt deltas, no duplicates. */
function validateDeltas(deltas: readonly ResourceDelta[]): void {
  if (deltas.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'Resource mutation must touch at least one resource')
  }
  const seen = new Set<string>()
  for (const { resource, delta } of deltas) {
    assertEconomyResource(resource)
    assertDelta(resource, delta)
    if (seen.has(resource)) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Duplicate resource in one mutation: ${resource} — combine into a single entry`,
      )
    }
    seen.add(resource)
  }
}

/** Validates a positive-amount map (faucet costs / rewards), server-side only. */
function validateAmounts(
  amounts: Partial<Record<EconomyResource, bigint>>,
  kind: 'grant' | 'cost',
): ResourceDelta[] {
  const entries = Object.entries(amounts)
  if (entries.length === 0) {
    throw new AppError('VALIDATION_ERROR', `Resource ${kind} must include at least one resource`)
  }
  return entries.map(([resource, amount]) => {
    assertEconomyResource(resource)
    if (typeof amount !== 'bigint') {
      throw new AppError(
        'INVALID_AMOUNT',
        `Resource ${kind} for ${resource} must be a BigInt amount (server-side values only)`,
      )
    }
    if (amount <= 0n || amount > MAX_DELTA) {
      throw new AppError(
        'INVALID_AMOUNT',
        `Resource ${kind} for ${resource} must be a positive amount within the ceiling (1…${MAX_DELTA})`,
      )
    }
    return { resource, delta: kind === 'grant' ? amount : -amount }
  })
}

/** BigInt → number for error details (validated amounts stay below 2^53). */
function toSafeNumber(value: bigint): number {
  return Number(value)
}

// ── Balance reads ────────────────────────────────────────────────────────────

async function assertPlayerExists(client: ReadClient, playerId: string): Promise<void> {
  const player = await client.player.findUnique({ where: { id: playerId }, select: { id: true } })
  if (!player) throw new AppError('PLAYER_NOT_FOUND', 'Player not found')
}

async function readBalances(
  tx: ReadClient,
  playerId: string,
  resources: readonly EconomyResource[],
): Promise<Map<EconomyResource, bigint>> {
  await assertPlayerExists(tx, playerId)

  const walletResources = resources.filter(isWalletResource)
  const balances = new Map<EconomyResource, bigint>()

  if (walletResources.length > 0) {
    const wallet = await tx.resourceWallet.findUnique({ where: { playerId } })
    if (!wallet) {
      // Ledger-first invariant: a player without a wallet is a bootstrap bug.
      throw new AppError('INTERNAL_ERROR', 'Player wallet is missing')
    }
    for (const resource of walletResources) {
      balances.set(resource, wallet[WALLET_FIELD[resource]])
    }
  }

  if (resources.includes('GEMS')) {
    const player = await tx.player.findUnique({ where: { id: playerId }, select: { gems: true } })
    if (!player) throw new AppError('PLAYER_NOT_FOUND', 'Player not found')
    balances.set('GEMS', player.gems)
  }

  return balances
}

/** Full six-resource balance map (BigInt) — internal/tests/debug use. */
export async function getWalletBalances(
  client: ReadClient,
  playerId: string,
): Promise<Record<EconomyResource, bigint>> {
  const balances = await readBalances(client, playerId, ECONOMY_RESOURCES)
  return Object.fromEntries(balances) as Record<EconomyResource, bigint>
}

// ── Core mutation (tx-scoped — caller owns the transaction) ──────────────────

/**
 * Applies a validated batch of signed resource deltas inside the caller's
 * transaction and appends one ledger row per changed resource. All-or-nothing:
 * every balance precondition is checked BEFORE any write; a single failure
 * aborts the whole batch (and the caller's transaction).
 */
export async function applyResourceDeltas(
  tx: Tx,
  playerId: string,
  deltas: readonly ResourceDelta[],
  meta: LedgerWriteMeta,
): Promise<AppliedResourceDelta[]> {
  assertReason(meta.reason)
  validateDeltas(deltas)

  const balances = await readBalances(
    tx,
    playerId,
    deltas.map((d) => d.resource),
  )

  // ── Phase 1: plan + validate ALL preconditions (no writes yet) ────────────
  const plan: AppliedResourceDelta[] = []
  for (const { resource, delta } of deltas) {
    const balanceBefore = balances.get(resource)!
    let appliedDelta: bigint
    let balanceAfter: bigint
    let capped = false

    if (delta > 0n) {
      const cap = RESOURCE_CAPS[resource]
      const credit = creditWithCap(balanceBefore, delta, cap)
      appliedDelta = credit.applied
      balanceAfter = credit.balanceAfter
      capped = credit.capped
    } else {
      const amount = -delta
      const debit = debitBalance(balanceBefore, amount)
      if (!debit.ok) {
        // Negative balances are impossible — this is the typed refusal path.
        throw errors.insufficient(
          resource.toLowerCase() as Lowercase<string>,
          toSafeNumber(amount),
          toSafeNumber(balanceBefore),
        )
      }
      appliedDelta = delta
      balanceAfter = debit.balanceAfter
    }

    plan.push({
      resource,
      requestedDelta: delta,
      appliedDelta,
      balanceBefore,
      balanceAfter,
      capped,
      skipped: appliedDelta === 0n,
    })
  }

  // ── Phase 2: persist writes + ledger rows (same tx — atomic with caller) ──
  const ledgerRows: Prisma.ResourceTransactionCreateManyInput[] = []

  for (const entry of plan) {
    if (entry.skipped) continue // fully capped credit — no economic change

    if (isWalletResource(entry.resource)) {
      const field = WALLET_FIELD[entry.resource]
      if (entry.requestedDelta < 0n) {
        // Conditional compare-and-decrement: the DB-level guarantee that a
        // stored balance can never go negative, independent of any lock.
        const guard = await tx.resourceWallet.updateMany({
          where: {
            playerId,
            [field]: { gte: -entry.requestedDelta },
          } as Prisma.ResourceWalletWhereInput,
          data: {
            [field]: { decrement: -entry.requestedDelta },
          } as Prisma.ResourceWalletUpdateInput,
        })
        if (guard.count === 0) {
          throw errors.insufficient(
            entry.resource.toLowerCase() as Lowercase<string>,
            toSafeNumber(-entry.requestedDelta),
            toSafeNumber(entry.balanceBefore),
          )
        }
      } else {
        await tx.resourceWallet.update({
          where: { playerId },
          data: { [field]: entry.balanceAfter } as Prisma.ResourceWalletUpdateInput,
        })
      }
    } else {
      // GEMS — premium currency on Player.
      if (entry.requestedDelta < 0n) {
        const guard = await tx.player.updateMany({
          where: { id: playerId, gems: { gte: -entry.requestedDelta } },
          data: { gems: { decrement: -entry.requestedDelta } },
        })
        if (guard.count === 0) {
          throw errors.insufficient(
            entry.resource.toLowerCase() as Lowercase<string>,
            toSafeNumber(-entry.requestedDelta),
            toSafeNumber(entry.balanceBefore),
          )
        }
      } else {
        await tx.player.update({
          where: { id: playerId },
          data: { gems: entry.balanceAfter },
        })
      }
    }

    ledgerRows.push({
      playerId,
      resource: entry.resource,
      delta: entry.appliedDelta,
      balanceAfter: entry.balanceAfter,
      reason: meta.reason,
      refType: meta.refType,
      refId: meta.refId,
      metadata: meta.metadata,
    })
  }

  if (ledgerRows.length > 0) {
    await tx.resourceTransaction.createMany({ data: ledgerRows })
  }

  if (plan.some((entry) => entry.capped && !entry.skipped)) {
    log.info('resource credit clamped at cap', {
      playerId,
      reason: meta.reason,
      capped: plan.filter((e) => e.capped && !e.skipped).map((e) => e.resource),
    })
  }

  return plan
}

// ── Idempotent grants (faucets: quests, battles, events, admin faucets) ──────

interface StoredGrantResult {
  applied: Array<{
    resource: EconomyResource
    requestedDelta: string
    appliedDelta: string
    balanceBefore: string
    balanceAfter: string
    capped: boolean
    skipped: boolean
  }>
}

function serializeGrantResult(applied: AppliedResourceDelta[]): StoredGrantResult {
  return {
    applied: applied.map((entry) => ({
      resource: entry.resource,
      requestedDelta: entry.requestedDelta.toString(),
      appliedDelta: entry.appliedDelta.toString(),
      balanceBefore: entry.balanceBefore.toString(),
      balanceAfter: entry.balanceAfter.toString(),
      capped: entry.capped,
      skipped: entry.skipped,
    })),
  }
}

function hydrateGrantResult(stored: unknown): AppliedResourceDelta[] {
  if (
    typeof stored !== 'object' ||
    stored === null ||
    !Array.isArray((stored as StoredGrantResult).applied)
  ) {
    throw new AppError('INTERNAL_ERROR', 'Corrupt idempotency record for resource grant')
  }
  return (stored as StoredGrantResult).applied.map((entry) => ({
    resource: entry.resource,
    requestedDelta: BigInt(entry.requestedDelta),
    appliedDelta: BigInt(entry.appliedDelta),
    balanceBefore: BigInt(entry.balanceBefore),
    balanceAfter: BigInt(entry.balanceAfter),
    capped: entry.capped,
    skipped: entry.skipped,
  }))
}

const GRANT_ACTION = 'resource_grant'
const IDEMPOTENCY_KEY_MAX_LENGTH = 128

/** Stable hash of the grant intent — a key reused with a different payload is a caller bug. */
function grantRequestHash(
  playerId: string,
  amounts: Partial<Record<EconomyResource, bigint>>,
  meta: LedgerWriteMeta,
): string {
  const canonical = JSON.stringify({
    playerId,
    reason: meta.reason,
    refType: meta.refType ?? null,
    refId: meta.refId ?? null,
    amounts: Object.entries(amounts)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([resource, amount]) => [resource, (amount as bigint).toString()]),
  })
  return createHash('sha256').update(canonical).digest('hex')
}

export interface GrantOptions extends LedgerWriteMeta {
  /**
   * Duplicate-reward guard. Within the TTL, replaying the same key with the
   * same payload returns the ORIGINAL result (replayed: true) instead of
   * paying out twice; the same key with a DIFFERENT payload is rejected.
   * The key row commits atomically with the payout (same transaction).
   */
  idempotencyKey?: string
}

/**
 * Credits resources inside the caller's transaction. Every amount must be a
 * positive BigInt — faucets are explicit, there is no "sign" channel for
 * callers to abuse. Credits clamp at the resource cap (overflow-safe).
 */
export async function grantResources(
  tx: Tx,
  playerId: string,
  amounts: Partial<Record<EconomyResource, bigint>>,
  options: GrantOptions,
): Promise<GrantResult> {
  const { idempotencyKey, ...meta } = options
  const deltas = validateAmounts(amounts, 'grant')

  if (idempotencyKey === undefined) {
    return { applied: await applyResourceDeltas(tx, playerId, deltas, meta), replayed: false }
  }

  if (
    typeof idempotencyKey !== 'string' ||
    idempotencyKey.length === 0 ||
    idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH
  ) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Idempotency key must be a 1…${IDEMPOTENCY_KEY_MAX_LENGTH} character string`,
    )
  }

  const requestHash = grantRequestHash(playerId, amounts, meta)

  // 1) Replay fast-path — the key exists → this grant already committed.
  const existing = await tx.idempotencyKey.findUnique({ where: { key: idempotencyKey } })
  if (existing) {
    if (existing.action !== GRANT_ACTION || existing.requestHash !== requestHash) {
      throw new AppError(
        'IDEMPOTENT_REPLAY',
        'Idempotency key was already used for a different grant',
      )
    }
    if (existing.responseBody === null) {
      // Unreachable while keys commit with their payout — defensive anyway.
      throw new AppError('IDEMPOTENT_REPLAY', 'Grant is still in flight — retry shortly')
    }
    return { applied: hydrateGrantResult(existing.responseBody), replayed: true }
  }

  // 2) Claim the key inside the payout transaction (unique constraint is the
  //    arbiter for concurrent duplicates), apply, then record the result.
  const expiresAt = new Date(Date.now() + GRANT_IDEMPOTENCY_TTL_SECONDS * 1000)
  try {
    await tx.idempotencyKey.create({
      data: {
        key: idempotencyKey,
        playerId,
        action: GRANT_ACTION,
        requestHash,
        expiresAt,
      },
    })
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Concurrent duplicate lost the unique race — its tx is unusable; the
      // caller re-issues and lands on the replay path above.
      throw new AppError(
        'IDEMPOTENT_REPLAY',
        'Concurrent duplicate grant — retry to read the recorded result',
      )
    }
    throw err
  }

  const applied = await applyResourceDeltas(tx, playerId, deltas, meta)
  await tx.idempotencyKey.update({
    where: { key: idempotencyKey },
    data: { responseBody: serializeGrantResult(applied) as unknown as Prisma.InputJsonValue },
  })

  return { applied, replayed: false }
}

/**
 * Debits resources inside the caller's transaction (costs: positive BigInts).
 * Fails with the typed INSUFFICIENT_* error BEFORE any write when any balance
 * would go negative — costs are all-or-nothing.
 */
export async function spendResources(
  tx: Tx,
  playerId: string,
  costs: Partial<Record<EconomyResource, bigint>>,
  meta: LedgerWriteMeta,
): Promise<AppliedResourceDelta[]> {
  const deltas = validateAmounts(costs, 'cost')
  return applyResourceDeltas(tx, playerId, deltas, meta)
}

// ── Standalone transaction runner (per-player serialization + retry) ─────────

/** Generous interactive-tx bounds — wallet sections queue on the mutex, not the DB lock. */
export const ECONOMY_TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const

/**
 * Runs an economy-class transaction serialized behind the player's wallet
 * mutex with bounded transient-retry (SQLite BUSY/P1008 in dev; harmless on
 * PostgreSQL). Embedded callers that already own a tx should NOT use this —
 * they call applyResourceDeltas/spend/grant directly inside their own tx.
 */
export async function runEconomyTransaction<T>(
  playerId: string,
  run: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withKeyLock(`wallet:${playerId}`, () =>
    withWriteRetry(() => db.$transaction(run, ECONOMY_TX_OPTIONS)),
  )
}

// ── Admin adjustment (audited — reason: ADMIN_ADJUSTMENT) ────────────────────

export interface AdminAdjustmentInput {
  playerId: string
  /** Authenticated admin user id (AuditLog actor). */
  actorUserId: string
  /** Human justification — persisted on the ledger rows AND the audit row. */
  note: string
  /** Signed BigInt deltas (positive credit / negative debit), never zero. */
  adjustments: Partial<Record<EconomyResource, bigint>>
  refType?: string
  refId?: string
}

export interface AdminAdjustmentResult {
  applied: AppliedResourceDelta[]
  balances: Record<EconomyResource, string>
}

/**
 * Operational correction path (support refunds, exploit cleanups). Runs in
 * its OWN serialized transaction, enforces the same no-negative/no-overflow
 * rules, and writes an AuditLog row with before/after balances in the same
 * transaction — an untracked adjustment is structurally impossible.
 */
export async function adminAdjustResources(
  input: AdminAdjustmentInput,
): Promise<AdminAdjustmentResult> {
  const { playerId, actorUserId, note, adjustments } = input

  if (typeof note !== 'string' || note.trim().length === 0 || note.trim().length > 500) {
    throw new AppError('VALIDATION_ERROR', 'Admin adjustment requires a note (1…500 chars)')
  }
  if (typeof actorUserId !== 'string' || actorUserId.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'Admin adjustment requires an authenticated actor')
  }
  const deltas = Object.entries(adjustments).map(([resource, delta]) => {
    assertEconomyResource(resource)
    assertDelta(resource, delta)
    return { resource, delta }
  })
  validateDeltas(deltas)

  return runEconomyTransaction(playerId, async (tx) => {
    const before = await getWalletBalances(tx, playerId)
    const applied = await applyResourceDeltas(tx, playerId, deltas, {
      reason: 'ADMIN_ADJUSTMENT',
      refType: input.refType,
      refId: input.refId,
      metadata: { actorUserId, note: note.trim() },
    })
    const after = await getWalletBalances(tx, playerId)

    await tx.auditLog.create({
      data: {
        actorUserId,
        action: 'ADJUST_RESOURCES',
        targetType: 'player',
        targetId: playerId,
        before: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.toString()])),
        after: Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v.toString()])),
        reason: note.trim(),
      },
    })

    log.info('admin resource adjustment applied', {
      playerId,
      actorUserId,
      resources: applied.map((a) => a.resource),
    })

    return {
      applied,
      balances: Object.fromEntries(
        Object.entries(after).map(([k, v]) => [k, v.toString()]),
      ) as Record<EconomyResource, string>,
    }
  })
}

// ── Read models (API surface) ────────────────────────────────────────────────

export interface WalletResourceView {
  key: EconomyResource
  balance: string
  cap: string
  headroom: string
}

export interface WalletView {
  playerId: string
  resources: WalletResourceView[]
  /** Wallet row mutation timestamp (the five wallet resources). */
  updatedAt: string
}

/**
 * Server-owned wallet projection: every amount crosses the API as a string
 * (BigInt policy); caps and headroom come from config so clients can render
 * progress bars without ever doing authority math.
 */
export async function getWalletView(client: ReadClient, playerId: string): Promise<WalletView> {
  await assertPlayerExists(client, playerId)
  const wallet = await client.resourceWallet.findUnique({ where: { playerId } })
  if (!wallet) {
    throw new AppError('INTERNAL_ERROR', 'Player wallet is missing')
  }
  const player = await client.player.findUnique({ where: { id: playerId }, select: { gems: true } })
  if (!player) throw new AppError('PLAYER_NOT_FOUND', 'Player not found')

  const stored: Record<EconomyResource, bigint> = {
    GOLD: wallet.gold,
    WOOD: wallet.wood,
    IRON: wallet.iron,
    FOOD: wallet.food,
    CRYSTAL: wallet.crystal,
    GEMS: player.gems,
  }

  return {
    playerId,
    resources: ECONOMY_RESOURCES.map((key) => {
      const cap = RESOURCE_CAPS[key]
      const balance = stored[key]
      return {
        key,
        balance: balance.toString(),
        cap: cap.toString(),
        headroom: (cap > balance ? cap - balance : 0n).toString(),
      }
    }),
    updatedAt: wallet.updatedAt.toISOString(),
  }
}

// ── Ledger history (keyset-paginated, reason-filterable) ─────────────────────

export interface LedgerEntryDto {
  id: string
  resource: EconomyResource
  delta: string
  balanceAfter: string
  reason: string
  refType: string | null
  refId: string | null
  metadata: unknown
  createdAt: string
}

export interface LedgerHistoryPage {
  entries: LedgerEntryDto[]
  nextCursor: string | null
  hasMore: boolean
}

export interface HistoryOptions {
  limit?: number
  /** Opaque cursor from a previous page (createdAt|id keyset). */
  cursor?: string | null
  /** Optional ledger-reason filter (validated against the catalog). */
  reason?: string
}

const CURSOR_SEPARATOR = '|'

function encodeCursor(entry: { createdAt: Date; id: string }): string {
  return `${entry.createdAt.toISOString()}${CURSOR_SEPARATOR}${entry.id}`
}

function decodeCursor(raw: string): { createdAt: Date; id: string } {
  const separatorIndex = raw.indexOf(CURSOR_SEPARATOR)
  const createdAtMs = separatorIndex === -1 ? NaN : Date.parse(raw.slice(0, separatorIndex))
  const id = separatorIndex === -1 ? '' : raw.slice(separatorIndex + 1)
  if (Number.isNaN(createdAtMs) || id.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'Malformed history cursor')
  }
  return { createdAt: new Date(createdAtMs), id }
}

/**
 * Ledger history for one player, newest first, keyset-paginated by
 * (createdAt, id). Only the player's OWN rows are ever reachable — the
 * playerId comes from the authenticated principal, never from input.
 */
export async function getTransactionHistory(
  client: ReadClient,
  playerId: string,
  options: HistoryOptions = {},
): Promise<LedgerHistoryPage> {
  const { limit, cursor, reason } = options

  let pageSize: number = ECONOMY_HISTORY.defaultPageSize
  if (limit !== undefined) {
    if (!Number.isInteger(limit)) {
      throw new AppError('VALIDATION_ERROR', 'History limit must be an integer')
    }
    pageSize = Math.min(Math.max(limit, 1), ECONOMY_HISTORY.maxPageSize)
  }

  let reasonFilter: LedgerReason | undefined
  if (reason !== undefined) {
    assertReason(reason)
    reasonFilter = reason
  }

  const keyset =
    cursor === undefined || cursor === null || cursor.length === 0
      ? undefined
      : decodeCursor(cursor)

  const rows = await client.resourceTransaction.findMany({
    where: {
      playerId,
      ...(reasonFilter ? { reason: reasonFilter } : {}),
      ...(keyset
        ? {
            OR: [
              { createdAt: { lt: keyset.createdAt } },
              { createdAt: keyset.createdAt, id: { lt: keyset.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: pageSize + 1,
  })

  const hasMore = rows.length > pageSize
  const page = hasMore ? rows.slice(0, pageSize) : rows
  const last = page.at(-1)

  return {
    entries: page.map((row) => ({
      id: row.id,
      resource: row.resource as EconomyResource,
      delta: row.delta.toString(),
      balanceAfter: row.balanceAfter.toString(),
      reason: row.reason,
      refType: row.refType,
      refId: row.refId,
      metadata: row.metadata,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: hasMore && last ? encodeCursor(last) : null,
    hasMore,
  }
}

// Re-exported so route/query layers never deep-import the config module.
export { ECONOMY_RESOURCES, LEDGER_REASONS, RESOURCE_CAPS }
export type { EconomyResource, LedgerReason }
