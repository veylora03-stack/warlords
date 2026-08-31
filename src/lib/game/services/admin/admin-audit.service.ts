/**
 * WARLORDS — Admin audit service (Phase 21).
 *
 * EVERY admin action lands in audit_logs:
 *   - MUTATIONS write their audit row INSIDE the same transaction as the
 *     change (before/after snapshots) — an untracked mutation is
 *     structurally impossible: the audit commits or the mutation doesn't.
 *   - READ inspections (player details, battle/economy inspection) write a
 *     lightweight VIEW row best-effort — inspections are sensitive too
 *     (privacy trail), but must never break the read they are auditing.
 */

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { logger } from '@/lib/logger'
import type { Tx } from '../player-bootstrap.service'
import { ADMIN_PANEL_POLICY } from '@/lib/game/config/admin'

const log = logger.child({ module: 'game/admin/audit' })

export type AdminAuditTarget =
  'player' | 'user' | 'clan' | 'event' | 'announcement' | 'battle' | 'staff' | 'season'

export interface AdminAuditInput {
  actorUserId: string
  action: string
  targetType: AdminAuditTarget
  targetId?: string | null
  before?: unknown
  after?: unknown
  reason?: string
  ip?: string
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined
  return value as Prisma.InputJsonValue
}

/** Transactional audit — call inside the mutation's transaction. */
export async function recordAdminAuditInTx(tx: Tx, input: AdminAuditInput): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      before: toJson(input.before),
      after: toJson(input.after),
      reason: input.reason,
      ip: input.ip,
    },
  })
}

/** Best-effort audit for READ inspections — logged, never fatal. */
export async function recordAdminAuditView(input: AdminAuditInput): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actorUserId: input.actorUserId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        reason: input.reason,
        ip: input.ip,
      },
    })
  } catch (err) {
    log.warn('admin view audit write failed (read continues)', {
      action: input.action,
      targetId: input.targetId,
      err,
    })
  }
}

// ── Audit log query (admin panel viewer) ─────────────────────────────────────

export interface AuditLogRow {
  id: string
  action: string
  targetType: string
  targetId: string | null
  reason: string | null
  before: unknown
  after: unknown
  createdAt: string
  actor: { userId: string; name: string | null; telegramId: string }
}

export interface Paginated<T> {
  rows: T[]
  page: number
  pageSize: number
  total: number
  pages: number
}

function paginate(
  total: number,
  page: number,
  pageSize: number,
): {
  page: number
  pageSize: number
  pages: number
} {
  return { page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) }
}

export async function listAuditLogs(input: {
  action?: string
  targetType?: string
  actorUserId?: string
  page: number
  pageSize: number
}): Promise<Paginated<AuditLogRow>> {
  const where = {
    ...(input.action ? { action: input.action } : {}),
    ...(input.targetType ? { targetType: input.targetType } : {}),
    ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
  }
  const [total, rows] = await Promise.all([
    db.auditLog.count({ where }),
    db.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      include: { actor: { select: { username: true, telegramId: true } } },
    }),
  ])
  return {
    rows: rows.map((row) => ({
      id: row.id,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      reason: row.reason,
      before: row.before,
      after: row.after,
      createdAt: row.createdAt.toISOString(),
      actor: {
        userId: row.actorUserId,
        name: row.actor.username,
        telegramId: row.actor.telegramId,
      },
    })),
    total,
    ...paginate(total, input.page, input.pageSize),
  }
}

/** Default paging resolver shared by every admin list endpoint. */
export function resolvePaging(
  rawPage: number,
  rawPageSize: number,
): {
  page: number
  pageSize: number
} {
  const page = Math.max(1, Math.floor(rawPage) || 1)
  const pageSize = Math.min(
    Math.max(1, Math.floor(rawPageSize) || ADMIN_PANEL_POLICY.pageSizeDefault),
    ADMIN_PANEL_POLICY.pageSizeMax,
  )
  return { page, pageSize }
}
