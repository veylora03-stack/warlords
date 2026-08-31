/**
 * WARLORDS — Notification engine (Phase 22: Notification System).
 *
 * THE single server-side write path for notifications. Producers enqueue
 * INSIDE the game transaction that caused the event (construction claim,
 * training claim, settlement, admin fan-outs…), so a notification can never
 * exist without its cause and vice versa: enqueue-then-rollback = no
 * notification, exactly like the ledger.
 *
 * Pipeline:
 *
 *   game tx ──enqueueNotificationInTx──▶ notification_queue (PENDING)
 *                                             │  dedupe: @@unique(playerId,type,dedupeKey)
 *                                             ▼
 *   worker tick ──claim(PENDING→PROCESSING, atomic count===1)──▶ render (catalog)
 *                                             │
 *                             ┌───────────────┴──────────────────┐
 *                             ▼                                  ▼
 *                     IN_APP inbox row                  Telegram Bot API push
 *                    (notifications, idempotent              (real HTTP, env-gated;
 *                     via notificationId backlink)          unconfigured → SKIPPED)
 *                             │                                  │
 *                             ▼                                  ▼
 *                          SENT  ·  SKIPPED  ·  retry w/ backoff → FAILED
 *
 * Guarantees (all tested):
 *  - QUEUEABLE — every notification is a durable row with claim/backoff/attempt
 *    state; workers compete through atomic conditional UPDATEs (count===1),
 *    so multiple instances (dev server + a future dedicated worker) converge
 *    without double delivery.
 *  - DUPLICATE-PROOF — the (playerId, type, dedupeKey) unique index makes
 *    enqueue idempotent (P2002 → no-op) and fan-outs skipDuplicates; the
 *    dedupeKey carries the EVENT IDENTITY ("construction:{buildingId}:{level}"),
 *    not merely the entity id.
 *  - CRASH-SAFE — a PROCESSING row older than staleClaimMs is re-claimable;
 *    IN_APP delivery is idempotent through the notificationId backlink.
 *  - NEVER TRUST THE CLIENT — payloads are validated against the per-type
 *    Zod schema at enqueue and rendered server-side; no client string ever
 *    reaches a notification body.
 */

import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { db } from '@/lib/db'
import { logger } from '@/lib/logger'
import type { Tx } from '@/lib/game/services/player-bootstrap.service'
import { isUniqueConstraintError } from '@/lib/game/services/prisma-errors'
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_POLICY,
  NOTIFICATION_TYPE_CHANNELS,
  notificationBackoffDelayMs,
  renderNotification,
  validateNotificationPayload,
  NOTIFICATION_PAYLOAD_SCHEMAS,
  type NotificationChannel,
  type NotificationPayloadMap,
} from '@/lib/game/config/notifications'
import type { NotificationType } from '@/lib/game/types/common'
import {
  resolveTelegramDeliveryConfig,
  sendTelegramMessage,
  TelegramDeliveryError,
  type TelegramDeliveryConfig,
} from '@/lib/telegram/send-message'

const log = logger.child({ module: 'game/notifications' })

// ── Enqueue (producer API — called INSIDE game transactions) ─────────────────

export interface EnqueueNotificationInput<K extends NotificationType> {
  playerId: string
  type: K
  /** EVENT IDENTITY dedupe key (see notificationDedupeKeys). */
  dedupeKey: string
  /** Validated against the per-type schema — invalid payloads fail the tx. */
  payload: NotificationPayloadMap[K]
  /** Optional NARROWING of the catalog channels (never an expansion). */
  channels?: readonly NotificationChannel[]
}

export interface EnqueueResult {
  /** false → a notification with this (playerId, type, dedupeKey) already exists. */
  enqueued: boolean
  id: string | null
}

function resolveChannels<K extends NotificationType>(
  type: K,
  override: readonly NotificationChannel[] | undefined,
): NotificationChannel[] {
  const catalog = NOTIFICATION_TYPE_CHANNELS[type]
  if (!override) return [...catalog]
  for (const channel of override) {
    if (!(NOTIFICATION_CHANNELS as readonly string[]).includes(channel)) {
      throw new Error(`Unknown notification channel: ${String(channel)}`)
    }
    if (!catalog.includes(channel)) {
      // Fail-closed: a producer may not push through a channel the catalog
      // did not bless for this type (config bug guard, not client-reachable).
      throw new Error(
        `Channel ${channel} is not enabled for ${type} (catalog: ${catalog.join(', ')})`,
      )
    }
  }
  return [...override]
}

/**
 * Enqueues one notification inside the caller's transaction. Duplicate-safe:
 * a repeated (playerId, type, dedupeKey) hits the unique index and resolves
 * as a no-op instead of failing the game action.
 */
export async function enqueueNotificationInTx<K extends NotificationType>(
  tx: Tx,
  input: EnqueueNotificationInput<K>,
): Promise<EnqueueResult> {
  if (input.dedupeKey.length === 0 || input.dedupeKey.length > 200) {
    throw new Error('Notification dedupeKey must be 1..200 chars')
  }
  const payload = validateNotificationPayload(input.type, input.payload)
  const channels = resolveChannels(input.type, input.channels)
  try {
    const row = await tx.notificationQueue.create({
      data: {
        playerId: input.playerId,
        type: input.type,
        dedupeKey: input.dedupeKey,
        channels,
        payload: payload as unknown as Prisma.InputJsonValue,
        status: 'PENDING',
      },
    })
    return { enqueued: true, id: row.id }
  } catch (err) {
    if (isUniqueConstraintError(err)) return { enqueued: false, id: null }
    throw err
  }
}

export interface FanOutNotificationInput<K extends NotificationType> {
  type: K
  /** Per-player EVENT IDENTITY key (same key string across players is fine —
   *  the unique index is scoped by playerId). */
  dedupeKeyFor: (playerId: string) => string
  /** Per-player payload (validated per row before the batch insert). */
  payloadFor: (playerId: string) => NotificationPayloadMap[K]
  channels?: readonly NotificationChannel[]
}

/**
 * Fans one notification type out to many players (announcements, world
 * events, season ranks) inside the caller's transaction. Rows whose
 * (playerId, type, dedupeKey) already exist are skipped — a replayed
 * broadcast cannot re-notify.
 *
 * SQLite has no INSERT ON CONFLICT DO NOTHING through Prisma
 * (`skipDuplicates` is unsupported), so the skip is computed by pre-reading
 * the existing (playerId, dedupeKey) pairs and inserting the remainder;
 * a concurrent racer that slips through the filter falls back to per-row
 * inserts where P2002 resolves per player as an idempotent no-op.
 *
 * Batching (Phase 23): both the pre-read WHERE and the createMany are
 * chunked below the platform bind-parameter ceilings (SQLite 32k / PG 65k
 * — the pre-read alone binds ~2 params per player), so a broadcast at the
 * configured hard cap cannot crash the causing transaction.
 */
const FAN_OUT_CHUNK = 500

export async function enqueueNotificationFanOutInTx<K extends NotificationType>(
  tx: Tx,
  playerIds: readonly string[],
  input: FanOutNotificationInput<K>,
): Promise<number> {
  if (playerIds.length === 0) return 0
  const channels = resolveChannels(input.type, input.channels)

  const rows: Prisma.NotificationQueueCreateManyInput[] = []
  for (const playerId of playerIds) {
    const payload = validateNotificationPayload(input.type, input.payloadFor(playerId))
    rows.push({
      playerId,
      type: input.type,
      dedupeKey: input.dedupeKeyFor(playerId),
      channels,
      payload: payload as unknown as Prisma.InputJsonValue,
      status: 'PENDING',
    })
  }

  const existing = new Set<string>()
  for (let i = 0; i < rows.length; i += FAN_OUT_CHUNK) {
    const chunk = rows.slice(i, i + FAN_OUT_CHUNK)
    const existingPairs = await tx.notificationQueue.findMany({
      where: {
        type: input.type,
        playerId: { in: chunk.map((row) => row.playerId as string) },
        dedupeKey: { in: chunk.map((row) => row.dedupeKey as string) },
      },
      select: { playerId: true, dedupeKey: true },
    })
    for (const pair of existingPairs) existing.add(`${pair.playerId}\u0000${pair.dedupeKey}`)
  }

  const fresh = rows.filter((row) => !existing.has(`${row.playerId}\u0000${row.dedupeKey}`))
  if (fresh.length === 0) return 0

  try {
    let inserted = 0
    for (let i = 0; i < fresh.length; i += FAN_OUT_CHUNK) {
      const result = await tx.notificationQueue.createMany({
        data: fresh.slice(i, i + FAN_OUT_CHUNK),
      })
      inserted += result.count
    }
    return inserted
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err
    // Concurrent fan-out inserted some of the same keys — resolve per row.
    let inserted = 0
    for (const row of fresh) {
      try {
        await tx.notificationQueue.create({ data: row })
        inserted += 1
      } catch (rowErr) {
        if (!isUniqueConstraintError(rowErr)) throw rowErr
      }
    }
    return inserted
  }
}

// ── Worker (drain) ───────────────────────────────────────────────────────────

export interface DrainNotificationOptions {
  /** Injectable clock (tests). */
  now?: Date
  /** Diagnostics identity of the draining worker instance. */
  workerId?: string
  /** Injectable transport (tests inject failures — production uses global fetch). */
  fetchImpl?: typeof fetch
  /** Injectable capability state (tests pin the push channel; production reads env). */
  telegramConfig?: TelegramDeliveryConfig
  /** Claim-batch override (tests). */
  batchSize?: number
}

export interface DrainNotificationResult {
  claimed: number
  sent: number
  skipped: number
  retried: number
  failed: number
}

interface QueueRow {
  id: string
  playerId: string
  type: string
  channels: unknown
  payload: unknown
  attempts: number
  maxAttempts: number
  notificationId: string | null
}

interface ProcessOutcome {
  kind: 'SENT' | 'SKIPPED' | 'RETRY' | 'FAILED'
  error?: string
}

/**
 * Identity of the CURRENT claim on a queue row. Every subsequent write to
 * the row (inbox backlink, final status) is conditional on this identity,
 * so a worker whose claim was stolen (stale-claim recovery) can no longer
 * clobber the re-claiming worker's state or double-deliver.
 */
interface ClaimIdentity {
  queueRowId: string
  workerId: string
  claimedAt: Date
}

/** Internal signal: our claim was superseded — abort everything, write nothing. */
class StaleClaimError extends Error {
  constructor() {
    super('notification queue claim was superseded by another worker')
  }
}

const TERMINAL_PRUNE_STATUSES = ['SENT', 'FAILED', 'SKIPPED'] as const

function isNotificationType(type: string): type is NotificationType {
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_PAYLOAD_SCHEMAS, type)
}

interface InboxDeliveryResult {
  /** True when our claim was superseded mid-delivery — abort processing. */
  lostClaim: boolean
  inboxId: string | null
}

/**
 * Creates the inbox row and links it to the queue row EXACTLY ONCE, inside
 * ONE transaction whose queue-row write is conditional on the claim
 * identity. The old code created the inbox outside any transaction: a row
 * stuck in PROCESSING past staleClaimMs was re-claimable while the original
 * worker still ran, and BOTH workers could see notificationId===null and
 * both create an inbox row (duplicate delivery) — the Notification table
 * has no natural unique key to backstop it. Now the stale worker's write
 * matches zero rows, the transaction aborts, and only the re-claiming
 * worker delivers.
 */
async function ensureInboxDelivered(
  row: QueueRow,
  rendered: { title: string; body: string },
  payload: NotificationPayloadMap[NotificationType],
  claim: ClaimIdentity,
): Promise<InboxDeliveryResult> {
  try {
    const inboxId = await db.$transaction(async (tx) => {
      // Re-read the backlink INSIDE the tx — our row snapshot may be stale.
      const current = await tx.notificationQueue.findUnique({
        where: { id: row.id },
        select: { notificationId: true },
      })
      if (!current) {
        // Row deleted between claim and delivery (player cascade) —
        // nothing to link; treat as delivered.
        return null
      }
      if (current.notificationId) return current.notificationId

      const inbox = await tx.notification.create({
        data: {
          playerId: row.playerId,
          type: row.type,
          title: rendered.title,
          body: rendered.body,
          data: { queueId: row.id, ...(payload as Record<string, unknown>) } as never,
        },
      })
      const guard = await tx.notificationQueue.updateMany({
        where: {
          id: claim.queueRowId,
          status: 'PROCESSING',
          claimedBy: claim.workerId,
          claimedAt: claim.claimedAt,
        },
        data: { notificationId: inbox.id },
      })
      if (guard.count === 0) throw new StaleClaimError()
      return inbox.id
    })
    return { lostClaim: false, inboxId }
  } catch (cause) {
    if (cause instanceof StaleClaimError) return { lostClaim: true, inboxId: null }
    throw cause
  }
}

/**
 * Processes one claimed row. Delivery order: IN_APP first (claim-guarded,
 * exactly-once via the notificationId backlink), then the push channels.
 * A push-channel failure after a successful inbox write retries ONLY the
 * push — the inbox row is never duplicated. Push delivery stays OUTSIDE
 * any transaction (an HTTP call cannot roll back): notifications are
 * therefore AT-LEAST-ONCE on push, exactly-once in the inbox — documented.
 */
async function processQueueItem(
  row: QueueRow,
  claim: ClaimIdentity,
  now: Date,
  fetchImpl: typeof fetch,
  telegramConfig: TelegramDeliveryConfig,
): Promise<ProcessOutcome | { kind: 'STALE' }> {
  if (!isNotificationType(row.type)) {
    // Unreachable: enqueue validates the type. A hand-corrupted row must
    // never loop the worker — park it, honestly failed.
    return { kind: 'FAILED', error: `Unknown notification type: ${row.type}` }
  }

  let payload: NotificationPayloadMap[NotificationType]
  let rendered: { title: string; body: string }
  try {
    payload = validateNotificationPayload(row.type, row.payload)
    rendered = renderNotification(row.type, payload)
  } catch (cause) {
    return {
      kind: 'FAILED',
      error: `Render failed (config bug): ${cause instanceof Error ? cause.message : 'unknown'}`,
    }
  }

  const channels = Array.isArray(row.channels)
    ? (row.channels as NotificationChannel[])
    : ['IN_APP' as const]

  // 1) IN_APP — exactly-once through the claim-guarded backlink write.
  if (channels.includes('IN_APP')) {
    const delivery = await ensureInboxDelivered(row, rendered, payload, claim)
    if (delivery.lostClaim) return { kind: 'STALE' }
  }

  // 2) Push channels — real transport, env-gated capability.
  const wantsTelegram = channels.includes('TELEGRAM')
  if (wantsTelegram) {
    if (!telegramConfig.token) {
      return {
        kind: 'SKIPPED',
        error:
          'TELEGRAM_NOT_CONFIGURED — push channel disabled on this deployment (inbox delivered)',
      }
    }
    const user = await db.user.findFirst({
      where: { player: { id: row.playerId } },
      select: { telegramId: true },
    })
    if (!user) {
      return {
        kind: 'FAILED',
        error: 'Player has no owning user — cannot resolve telegram chat id',
      }
    }
    try {
      await sendTelegramMessage(
        {
          token: telegramConfig.token,
          chatId: user.telegramId,
          text: `${rendered.title}\n\n${rendered.body}`,
        },
        fetchImpl,
      )
    } catch (cause) {
      if (cause instanceof TelegramDeliveryError) {
        return { kind: cause.retryable ? 'RETRY' : 'FAILED', error: cause.message }
      }
      return { kind: 'RETRY', error: cause instanceof Error ? cause.message : 'delivery error' }
    }
  }

  return { kind: 'SENT' }
}

/**
 * Parks a processed row in its terminal/retry state — conditional on the
 * claim identity, so a superseded worker cannot clobber the re-claiming
 * worker's state (double-counted attempts, lost backoff). Returns 'STALE'
 * when the write matched nothing: the row now belongs to someone else.
 */
async function finalizeQueueRow(
  claim: ClaimIdentity,
  attempts: number,
  maxAttempts: number,
  outcome: ProcessOutcome,
  now: Date,
): Promise<'SENT' | 'SKIPPED' | 'RETRY' | 'FAILED' | 'STALE'> {
  const guardWhere = {
    id: claim.queueRowId,
    status: 'PROCESSING' as const,
    claimedBy: claim.workerId,
    claimedAt: claim.claimedAt,
  }

  if (outcome.kind === 'SENT' || outcome.kind === 'SKIPPED') {
    const guard = await db.notificationQueue.updateMany({
      where: guardWhere,
      data: {
        status: outcome.kind,
        processedAt: now,
        lastError: outcome.error ?? null,
        claimedAt: null,
        claimedBy: null,
      },
    })
    return guard.count === 1 ? outcome.kind : 'STALE'
  }

  // RETRY / FAILED — bounded attempts with exponential backoff.
  if (outcome.kind === 'RETRY' && attempts < maxAttempts) {
    const guard = await db.notificationQueue.updateMany({
      where: guardWhere,
      data: {
        status: 'PENDING',
        availableAt: new Date(now.getTime() + notificationBackoffDelayMs(attempts)),
        lastError: outcome.error ?? null,
        claimedAt: null,
        claimedBy: null,
      },
    })
    return guard.count === 1 ? 'RETRY' : 'STALE'
  }

  const guard = await db.notificationQueue.updateMany({
    where: guardWhere,
    data: {
      status: 'FAILED',
      processedAt: now,
      lastError: outcome.error ?? null,
      claimedAt: null,
      claimedBy: null,
    },
  })
  return guard.count === 1 ? 'FAILED' : 'STALE'
}

/**
 * One worker tick: claim a batch of due rows (atomic per-row UPDATE —
 * concurrent workers converge without double processing), render + deliver
 * each, and park them in their terminal or retry state.
 *
 * Candidate set: due PENDING rows, plus PROCESSING rows whose claim is
 * older than staleClaimMs (a crashed worker's leaks). Re-claims count an
 * attempt, so a poison row cannot crash-loop forever.
 */
export async function drainNotificationQueue(
  options: DrainNotificationOptions = {},
): Promise<DrainNotificationResult> {
  const now = options.now ?? new Date()
  const workerId = options.workerId ?? `manual:${process.pid}`
  const fetchImpl = options.fetchImpl ?? fetch
  const telegramConfig = options.telegramConfig ?? resolveTelegramDeliveryConfig()
  const batchSize = options.batchSize ?? NOTIFICATION_POLICY.workerBatchSize
  const staleBefore = new Date(now.getTime() - NOTIFICATION_POLICY.staleClaimMs)

  const candidates = await db.notificationQueue.findMany({
    where: {
      OR: [
        { status: 'PENDING', availableAt: { lte: now } },
        { status: 'PROCESSING', claimedAt: { lt: staleBefore } },
      ],
    },
    orderBy: { availableAt: 'asc' },
    take: batchSize,
    select: { id: true },
  })

  const result: DrainNotificationResult = { claimed: 0, sent: 0, skipped: 0, retried: 0, failed: 0 }

  for (const candidate of candidates) {
    // Atomic claim — count===1 wins; concurrent workers lose silently.
    const claim = await db.notificationQueue.updateMany({
      where: {
        id: candidate.id,
        OR: [
          { status: 'PENDING', availableAt: { lte: now } },
          { status: 'PROCESSING', claimedAt: { lt: staleBefore } },
        ],
      },
      data: {
        status: 'PROCESSING',
        claimedAt: now,
        claimedBy: workerId,
        attempts: { increment: 1 },
      },
    })
    if (claim.count === 0) continue
    result.claimed += 1

    const claimIdentity: ClaimIdentity = {
      queueRowId: candidate.id,
      workerId,
      claimedAt: now,
    }

    const row = await db.notificationQueue.findUnique({ where: { id: candidate.id } })
    if (!row) {
      // Deleted between claim and read (player cascade) — nothing to do.
      continue
    }

    let outcome: ProcessOutcome | { kind: 'STALE' }
    try {
      outcome = await processQueueItem(
        row as QueueRow,
        claimIdentity,
        now,
        fetchImpl,
        telegramConfig,
      )
    } catch (cause) {
      // Defensive: an unexpected throw must not kill the tick.
      outcome = {
        kind: 'RETRY',
        error: cause instanceof Error ? cause.message : 'unexpected processing error',
      }
    }

    if (outcome.kind === 'STALE') {
      // Our claim was stolen while we worked — the re-claiming worker owns
      // this row now; write nothing and count nothing.
      log.warn('notification claim superseded mid-processing', {
        queueId: row.id,
        workerId,
      })
      continue
    }

    const parked = await finalizeQueueRow(
      claimIdentity,
      row.attempts,
      row.maxAttempts,
      outcome,
      now,
    )
    if (parked === 'SENT') result.sent += 1
    else if (parked === 'SKIPPED') result.skipped += 1
    else if (parked === 'RETRY') result.retried += 1
    else if (parked === 'FAILED') {
      result.failed += 1
      log.error('notification delivery failed terminally', {
        queueId: row.id,
        playerId: row.playerId,
        type: row.type,
        attempts: row.attempts,
        error: outcome.error,
      })
    } else {
      // Finalize raced a stale-claim recovery — same handling as above.
      log.warn('notification finalize lost its claim', { queueId: row.id, workerId })
    }
  }

  if (result.claimed > 0) {
    log.info('notification queue drained', { ...result, workerId })
  }

  return result
}

/**
 * Retention pruning — removes terminal queue rows and READ inbox rows past
 * the retention window. Unread inbox items persist until read by design.
 */
export async function pruneNotificationStorage(
  now: Date = new Date(),
): Promise<{ queueDeleted: number; inboxDeleted: number }> {
  const cutoff = new Date(now.getTime() - NOTIFICATION_POLICY.retentionDays * 24 * 3600 * 1000)
  const queueDeleted = await db.notificationQueue.deleteMany({
    where: { status: { in: [...TERMINAL_PRUNE_STATUSES] }, processedAt: { lt: cutoff } },
  })
  const inboxDeleted = await db.notification.deleteMany({
    where: { isRead: true, createdAt: { lt: cutoff } },
  })
  return { queueDeleted: queueDeleted.count, inboxDeleted: inboxDeleted.count }
}

// ── Inbox read model (player API) ────────────────────────────────────────────

export interface NotificationRow {
  id: string
  type: string
  title: string
  body: string
  data: unknown
  isRead: boolean
  createdAt: string
}

export interface ListNotificationsResult {
  notifications: NotificationRow[]
  unreadCount: number
}

export const notificationListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(NOTIFICATION_POLICY.listMaxLimit).optional(),
  unreadOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
})

/** Parsed shape of the inbox query (route owns parsing via defineRoute). */
export interface NotificationListQuery {
  limit?: number | undefined
  unreadOnly?: boolean | undefined
}

export async function listPlayerNotifications(
  playerId: string,
  query: NotificationListQuery = {},
): Promise<ListNotificationsResult> {
  // Re-validating the parsed shape costs nothing and keeps the service
  // safe for direct callers; VALIDATION_ERROR (not a raw ZodError) on junk.
  const { limit = NOTIFICATION_POLICY.listDefaultLimit, unreadOnly = false } =
    notificationListQuerySchema.parse({
      limit: query.limit === undefined ? undefined : String(query.limit),
      unreadOnly: query.unreadOnly === undefined ? undefined : query.unreadOnly ? 'true' : 'false',
    })
  const [rows, unreadCount] = await Promise.all([
    db.notification.findMany({
      where: { playerId, ...(unreadOnly ? { isRead: false } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    db.notification.count({ where: { playerId, isRead: false } }),
  ])
  return {
    notifications: rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      data: row.data,
      isRead: row.isRead,
      createdAt: row.createdAt.toISOString(),
    })),
    unreadCount,
  }
}

export async function countUnreadNotifications(playerId: string): Promise<number> {
  return db.notification.count({ where: { playerId, isRead: false } })
}

export const markNotificationsReadSchema = z
  .object({
    ids: z.array(z.string().min(1).max(64)).max(NOTIFICATION_POLICY.markReadMaxIds).optional(),
    all: z.boolean().optional(),
  })
  .refine((v) => v.all === true || (Array.isArray(v.ids) && v.ids.length > 0), {
    message: 'Provide ids or all:true',
  })

export async function markNotificationsRead(
  playerId: string,
  body: z.input<typeof markNotificationsReadSchema>,
): Promise<{ updated: number }> {
  const input = markNotificationsReadSchema.parse(body)
  const updated = await db.notification.updateMany({
    where: {
      playerId,
      isRead: false,
      ...(input.all ? {} : { id: { in: input.ids ?? [] } }),
    },
    data: { isRead: true },
  })
  return { updated: updated.count }
}
