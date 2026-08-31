/**
 * WARLORDS — GET /api/v1/admin/battles (scope: battles.view). READ-ONLY.
 *
 * Battle inspection list with filters (participant player, type) and
 * server-side paging.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { listBattles, resolvePaging } from '@/lib/game/services/admin'
import { clientIp } from '@/lib/api/request-info'

const battleQuery = z.object({
  playerId: z.string().min(1).max(64).optional(),
  type: z.string().min(1).max(32).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
})

export const GET = defineRoute({ query: battleQuery }, async ({ request, query }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { refreshed, adminUserId } = await requireAdminScope(request, 'battles.view', {
    refresh: true,
    config: cfg,
  })

  const result = await listBattles({
    playerId: query.playerId,
    type: query.type,
    ...resolvePaging(query.page, query.pageSize),
    actorUserId: adminUserId,
    ip: clientIp(request),
  })

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, result, { headers })
})
