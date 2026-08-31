/**
 * WARLORDS — Admin event management service (Phase 21).
 *
 * Operator surface over the server-driven `events` table: spawn, list,
 * finish, cancel. The RUNTIME effects of events belong to the event engine
 * (future phase) — this module manages the authoritative rows, audited and
 * state-machine-guarded. Status transitions are conditional updates
 * (count===1) so concurrent operators converge without double-finishes.
 */

import { db, dbWrite } from '@/lib/db'
import { AppError } from '@/lib/api/errors'
import { ADMIN_PANEL_POLICY } from '@/lib/game/config/admin'
import { notificationDedupeKeys } from '@/lib/game/config/notifications'
import { enqueueNotificationFanOutInTx } from '@/lib/game/services/notification.service'
import { recordAdminAuditInTx, recordAdminAuditView, type Paginated } from './admin-audit.service'

const EVENT_TYPES = [
  'GOLD_RUSH',
  'BANDIT_ATTACK',
  'PLAGUE',
  'FIRE',
  'MERCHANT_FLEET',
  'RARE_METEOR',
  'NPC_INVASION',
] as const
export type AdminEventType = (typeof EVENT_TYPES)[number]

export interface AdminEventRow {
  id: string
  type: string
  title: string | null
  body: string | null
  scope: string
  targetPlayerId: string | null
  targetPlayerName: string | null
  startsAt: string
  endsAt: string
  status: string
  createdById: string | null
  config: unknown
  createdAt: string
}

function toRow(row: {
  id: string
  type: string
  title: string | null
  body: string | null
  scope: string
  targetPlayerId: string | null
  targetPlayer?: { name: string } | null
  startsAt: Date
  endsAt: Date
  status: string
  createdById: string | null
  config: unknown
  createdAt: Date
}): AdminEventRow {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    scope: row.scope,
    targetPlayerId: row.targetPlayerId,
    targetPlayerName: row.targetPlayer?.name ?? null,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    status: row.status,
    createdById: row.createdById,
    config: row.config,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function listEvents(input: {
  status?: string
  page: number
  pageSize: number
  actorUserId: string
  ip?: string
}): Promise<Paginated<AdminEventRow>> {
  const where = { ...(input.status ? { status: input.status } : {}) }
  const [total, rows] = await Promise.all([
    db.gameEvent.count({ where }),
    db.gameEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      include: { targetPlayer: { select: { name: true } } },
    }),
  ])
  await recordAdminAuditView({
    actorUserId: input.actorUserId,
    action: 'VIEW_EVENTS',
    targetType: 'event',
    reason: `list page ${input.page} → ${total}`,
    ip: input.ip,
  })
  return {
    rows: rows.map(toRow),
    page: input.page,
    pageSize: input.pageSize,
    total,
    pages: Math.max(1, Math.ceil(total / input.pageSize)),
  }
}

export interface CreateEventInput {
  actorUserId: string
  type: string
  title?: string
  body?: string
  scope?: 'GLOBAL' | 'PLAYER' | 'CLAN'
  targetPlayerId?: string
  startsAt?: Date
  endsAt: Date
  config?: unknown
  ip?: string
}

export async function createEvent(input: CreateEventInput): Promise<AdminEventRow> {
  if (!(EVENT_TYPES as readonly string[]).includes(input.type)) {
    throw new AppError('VALIDATION_ERROR', `Unknown event type ${input.type}`)
  }
  const now = new Date()
  const startsAt = input.startsAt ?? now
  if (input.endsAt.getTime() <= startsAt.getTime()) {
    throw new AppError('EVENT_WINDOW_INVALID', 'endsAt must be after startsAt')
  }
  if (input.scope === 'PLAYER' && !input.targetPlayerId) {
    throw new AppError('VALIDATION_ERROR', 'PLAYER-scope events require targetPlayerId')
  }

  return dbWrite.$transaction(async (tx) => {
    if (input.targetPlayerId) {
      const target = await tx.player.findUnique({
        where: { id: input.targetPlayerId },
        select: { id: true },
      })
      if (!target) throw new AppError('PLAYER_NOT_FOUND', 'Target player not found')
    }

    const status = startsAt.getTime() <= now.getTime() ? 'ACTIVE' : 'SCHEDULED'
    const created = await tx.gameEvent.create({
      data: {
        type: input.type,
        title: input.title,
        body: input.body,
        scope: input.scope ?? 'GLOBAL',
        targetPlayerId: input.targetPlayerId ?? null,
        startsAt,
        endsAt: input.endsAt,
        status,
        createdById: input.actorUserId,
        config: (input.config ?? undefined) as never,
      },
      include: { targetPlayer: { select: { name: true } } },
    })

    // EVENT notice rides the notification engine (Phase 22): PLAYER-scope
    // events notify their target; GLOBAL/CLAN fan out to the (capped) player
    // set. Deduped by (player, EVENT, eventId) — a re-spawn of the same row
    // cannot re-notify, and the worker delivers after this tx commits.
    const eventTitle = input.title?.trim() || `${created.type} event`
    const eventBody =
      input.body?.trim() || `${created.type} event runs until ${created.endsAt.toISOString()}.`
    const recipients =
      created.scope === 'PLAYER'
        ? [created.targetPlayerId!]
        : (
            await tx.player.findMany({
              select: { id: true },
              take: ADMIN_PANEL_POLICY.broadcastHardCap,
            })
          ).map((row) => row.id)
    const notified = await enqueueNotificationFanOutInTx(tx, recipients, {
      type: 'EVENT',
      dedupeKeyFor: () => notificationDedupeKeys.event(created.id),
      payloadFor: () => ({ eventId: created.id, title: eventTitle, body: eventBody }),
    })

    await recordAdminAuditInTx(tx, {
      actorUserId: input.actorUserId,
      action: 'EVENT_SPAWN',
      targetType: 'event',
      targetId: created.id,
      after: {
        type: created.type,
        scope: created.scope,
        startsAt: created.startsAt.toISOString(),
        endsAt: created.endsAt.toISOString(),
        status: created.status,
        targetPlayerId: created.targetPlayerId,
        notifiedPlayers: notified,
      },
      reason: input.title,
      ip: input.ip,
    })

    return toRow(created)
  })
}

/** Shared finish/cancel core — conditional on the CURRENT status. */
async function transitionEvent(input: {
  eventId: string
  actorUserId: string
  action: 'EVENT_FINISH' | 'EVENT_CANCEL'
  from: string[]
  to: 'FINISHED' | 'CANCELLED'
  reason?: string
  ip?: string
}): Promise<AdminEventRow> {
  return dbWrite.$transaction(async (tx) => {
    const existing = await tx.gameEvent.findUnique({
      where: { id: input.eventId },
      include: { targetPlayer: { select: { name: true } } },
    })
    if (!existing) throw new AppError('EVENT_NOT_FOUND', 'Event not found')
    if (!input.from.includes(existing.status)) {
      throw new AppError(
        'EVENT_NOT_ACTIVE',
        `Event status is ${existing.status} — cannot transition to ${input.to}`,
      )
    }

    const claim = await tx.gameEvent.updateMany({
      where: { id: input.eventId, status: { in: input.from } },
      data: { status: input.to },
    })
    if (claim.count !== 1) {
      throw new AppError('EVENT_NOT_ACTIVE', 'Event was transitioned concurrently')
    }

    await recordAdminAuditInTx(tx, {
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: 'event',
      targetId: input.eventId,
      before: { status: existing.status },
      after: { status: input.to },
      reason: input.reason,
      ip: input.ip,
    })

    return toRow({ ...existing, status: input.to })
  })
}

export function finishEvent(input: {
  eventId: string
  actorUserId: string
  reason?: string
  ip?: string
}): Promise<AdminEventRow> {
  return transitionEvent({
    ...input,
    action: 'EVENT_FINISH',
    from: ['SCHEDULED', 'ACTIVE'],
    to: 'FINISHED',
  })
}

export function cancelEvent(input: {
  eventId: string
  actorUserId: string
  reason?: string
  ip?: string
}): Promise<AdminEventRow> {
  return transitionEvent({
    ...input,
    action: 'EVENT_CANCEL',
    from: ['SCHEDULED', 'ACTIVE'],
    to: 'CANCELLED',
  })
}
