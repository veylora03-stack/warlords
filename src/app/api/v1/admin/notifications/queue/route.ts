/**
 * WARLORDS — GET /api/v1/admin/notifications/queue (ADMIN ONLY).
 *
 * Operator view over the notification outbox: aggregate counters by status,
 * plus the most recent rows (newest first) with status/type/attempts/error
 * for diagnosing delivery problems. Read-only; the RBAC scope
 * `notifications.drain` resolves server-side.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { db } from '@/lib/db'
import { NOTIFICATION_POLICY } from '@/lib/game/config/notifications'

const queueQuerySchema = z.object({
  status: z.enum(['PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SKIPPED']).optional(),
  type: z.string().trim().min(1).max(40).optional(),
})

export const GET = defineRoute({ query: queueQuerySchema }, async ({ request, query }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { refreshed } = await requireAdminScope(request, 'notifications.drain', {
    refresh: true,
    config: cfg,
  })

  const where = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.type ? { type: query.type } : {}),
  }

  const groupByStatus = await db.notificationQueue.groupBy({
    by: ['status'],
    _count: { _all: true },
  })

  const rows = await db.notificationQueue.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: NOTIFICATION_POLICY.queueViewLimit,
    select: {
      id: true,
      playerId: true,
      type: true,
      dedupeKey: true,
      status: true,
      attempts: true,
      maxAttempts: true,
      availableAt: true,
      lastError: true,
      notificationId: true,
      createdAt: true,
      processedAt: true,
    },
  })

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(
    request,
    {
      stats: groupByStatus.map((group) => ({ status: group.status, count: group._count._all })),
      rows: rows.map((row) => ({
        ...row,
        availableAt: row.availableAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        processedAt: row.processedAt?.toISOString() ?? null,
      })),
    },
    { headers },
  )
})
