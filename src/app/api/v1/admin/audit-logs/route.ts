/**
 * WARLORDS — GET /api/v1/admin/audit-logs (scope: audit.view). READ-ONLY.
 *
 * The audit viewer: every admin action is recorded here — filter by action,
 * target type or actor; newest first, server-side paging.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { listAuditLogs, resolvePaging } from '@/lib/game/services/admin'

const auditQuery = z.object({
  action: z.string().min(1).max(64).optional(),
  targetType: z.string().min(1).max(32).optional(),
  actorUserId: z.string().min(1).max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
})

export const GET = defineRoute({ query: auditQuery }, async ({ request, query }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { refreshed } = await requireAdminScope(request, 'audit.view', {
    refresh: true,
    config: cfg,
  })

  const result = await listAuditLogs({
    action: query.action,
    targetType: query.targetType,
    actorUserId: query.actorUserId,
    ...resolvePaging(query.page, query.pageSize),
  })

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, result, { headers })
})
