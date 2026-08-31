/**
 * WARLORDS — GET /api/v1/admin/players (scope: players.search).
 *
 * Player search for the admin panel: name / id / telegramId / username.
 * Server-side paging (1…50). Returns ban state with every row — the panel
 * never needs a second round-trip to know who is banned.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { resolvePaging, searchPlayers } from '@/lib/game/services/admin'
import { clientIp } from '@/lib/api/request-info'

const searchQuery = z.object({
  q: z.string().min(1).max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
})

export const GET = defineRoute({ query: searchQuery }, async ({ request, query }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { refreshed, adminUserId } = await requireAdminScope(request, 'players.search', {
    refresh: true,
    config: cfg,
  })

  const result = await searchPlayers({
    q: query.q,
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
