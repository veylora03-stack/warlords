/**
 * WARLORDS — Admin announcement service (Phase 21).
 *
 * Create (typed audience), activate/deactivate, and BROADCAST — the
 * broadcast fans the announcement out into every player's notification
 * inbox inside ONE transaction, counted and audited. An inactive
 * announcement cannot be broadcast (ANNOUNCEMENT_INACTIVE).
 */

import { db, dbWrite } from '@/lib/db'
import { AppError } from '@/lib/api/errors'
import { ADMIN_PANEL_POLICY } from '@/lib/game/config/admin'
import { notificationDedupeKeys } from '@/lib/game/config/notifications'
import { enqueueNotificationFanOutInTx } from '@/lib/game/services/notification.service'
import { recordAdminAuditInTx, recordAdminAuditView, type Paginated } from './admin-audit.service'

export type AnnouncementAudience = 'ALL' | 'CLAN' | 'PLAYER'

export interface AdminAnnouncementRow {
  id: string
  title: string
  body: string
  audience: string
  clanId: string | null
  isActive: boolean
  createdById: string
  createdByName: string | null
  publishedAt: string
}

function toRow(row: {
  id: string
  title: string
  body: string
  audience: string
  clanId: string | null
  isActive: boolean
  createdById: string
  createdBy: { username: string | null } | null
  publishedAt: Date
}): AdminAnnouncementRow {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    audience: row.audience,
    clanId: row.clanId,
    isActive: row.isActive,
    createdById: row.createdById,
    createdByName: row.createdBy?.username ?? null,
    publishedAt: row.publishedAt.toISOString(),
  }
}

export async function listAnnouncements(input: {
  page: number
  pageSize: number
  actorUserId: string
  ip?: string
}): Promise<Paginated<AdminAnnouncementRow>> {
  const [total, rows] = await Promise.all([
    db.announcement.count(),
    db.announcement.findMany({
      orderBy: { publishedAt: 'desc' },
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      include: { createdBy: { select: { username: true } } },
    }),
  ])
  await recordAdminAuditView({
    actorUserId: input.actorUserId,
    action: 'VIEW_ANNOUNCEMENTS',
    targetType: 'announcement',
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

export interface CreateAnnouncementInput {
  actorUserId: string
  title: string
  body: string
  audience?: AnnouncementAudience
  clanId?: string
  ip?: string
}

export async function createAnnouncement(
  input: CreateAnnouncementInput,
): Promise<AdminAnnouncementRow> {
  if (input.title.trim().length < 4 || input.title.trim().length > 120) {
    throw new AppError('VALIDATION_ERROR', 'Announcement title must be 4…120 chars')
  }
  if (input.body.trim().length < 4 || input.body.trim().length > 2000) {
    throw new AppError('VALIDATION_ERROR', 'Announcement body must be 4…2000 chars')
  }

  const created = await dbWrite.$transaction(async (tx) => {
    if (input.audience === 'CLAN' && !input.clanId) {
      throw new AppError('VALIDATION_ERROR', 'CLAN audience requires clanId')
    }
    if (input.clanId) {
      const clan = await tx.clan.findUnique({ where: { id: input.clanId }, select: { id: true } })
      if (!clan) throw new AppError('CLAN_NOT_FOUND', 'Target clan not found')
    }

    const row = await tx.announcement.create({
      data: {
        title: input.title.trim(),
        body: input.body.trim(),
        audience: input.audience ?? 'ALL',
        clanId: input.audience === 'CLAN' ? input.clanId : null,
        createdById: input.actorUserId,
      },
      include: { createdBy: { select: { username: true } } },
    })

    await recordAdminAuditInTx(tx, {
      actorUserId: input.actorUserId,
      action: 'ANNOUNCE_CREATE',
      targetType: 'announcement',
      targetId: row.id,
      after: { title: row.title, audience: row.audience, clanId: row.clanId },
      ip: input.ip,
    })

    return row
  })

  return toRow(created)
}

export async function setAnnouncementActive(input: {
  announcementId: string
  actorUserId: string
  isActive: boolean
  ip?: string
}): Promise<AdminAnnouncementRow> {
  return dbWrite.$transaction(async (tx) => {
    const existing = await tx.announcement.findUnique({
      where: { id: input.announcementId },
      include: { createdBy: { select: { username: true } } },
    })
    if (!existing) throw new AppError('ANNOUNCEMENT_NOT_FOUND', 'Announcement not found')

    const claim = await tx.announcement.updateMany({
      where: { id: input.announcementId, isActive: !input.isActive },
      data: { isActive: input.isActive },
    })
    if (claim.count !== 1) {
      throw new AppError(
        'VALIDATION_ERROR',
        input.isActive ? 'Announcement is already active' : 'Announcement is already inactive',
      )
    }

    await recordAdminAuditInTx(tx, {
      actorUserId: input.actorUserId,
      action: input.isActive ? 'ANNOUNCE_ACTIVATE' : 'ANNOUNCE_DEACTIVATE',
      targetType: 'announcement',
      targetId: input.announcementId,
      before: { isActive: !input.isActive },
      after: { isActive: input.isActive },
      ip: input.ip,
    })

    return toRow({ ...existing, isActive: input.isActive })
  })
}

export interface BroadcastResult {
  announcementId: string
  notifiedPlayers: number
}

export async function broadcastAnnouncement(input: {
  announcementId: string
  actorUserId: string
  ip?: string
}): Promise<BroadcastResult> {
  return dbWrite.$transaction(async (tx) => {
    const announcement = await tx.announcement.findUnique({
      where: { id: input.announcementId },
    })
    if (!announcement) throw new AppError('ANNOUNCEMENT_NOT_FOUND', 'Announcement not found')
    if (!announcement.isActive) {
      throw new AppError('ANNOUNCEMENT_INACTIVE', 'Activate the announcement before broadcasting')
    }

    // Audience resolution — the real player set the announcement targets.
    const audienceWhere =
      announcement.audience === 'CLAN' && announcement.clanId ? { clanId: announcement.clanId } : {}
    const recipients = await tx.player.findMany({
      where: audienceWhere,
      select: { id: true },
      take: ADMIN_PANEL_POLICY.broadcastHardCap,
    })
    if (recipients.length === 0) {
      throw new AppError('VALIDATION_ERROR', 'No players match the announcement audience')
    }

    // Fan-out through the notification engine's queue (Phase 22): the rows
    // are deduped by (player, ANNOUNCEMENT, announcementId) — a replayed
    // broadcast cannot re-notify — and the worker renders + delivers them
    // (inbox; push channels per catalog) right after this tx commits.
    const notified = await enqueueNotificationFanOutInTx(
      tx,
      recipients.map((player) => player.id),
      {
        type: 'ANNOUNCEMENT',
        dedupeKeyFor: () => notificationDedupeKeys.announcement(announcement.id),
        payloadFor: () => ({
          announcementId: announcement.id,
          title: announcement.title,
          body: announcement.body,
        }),
      },
    )

    await recordAdminAuditInTx(tx, {
      actorUserId: input.actorUserId,
      action: 'ANNOUNCE_BROADCAST',
      targetType: 'announcement',
      targetId: announcement.id,
      after: { notifiedPlayers: notified, audience: announcement.audience },
      ip: input.ip,
    })

    return { announcementId: announcement.id, notifiedPlayers: notified }
  })
}
