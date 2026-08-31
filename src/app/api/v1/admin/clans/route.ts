/**
 * WARLORDS — GET /api/v1/admin/clans (scope: clans.view). READ-ONLY.
 *
 * Clan list for the management panel: search by name/tag, ordered by
 * trophies, with leader names and member counts.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { listClans, resolvePaging } from '@/lib/game/services/admin'
import { clientIp } from '@/lib/api/request-info'

const clanQuery = z.object({
  q: z.string().min(1).max(32).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
})

export const GET = defineRoute({ query: clanQuery }, async ({ request, query }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { refreshed, adminUserId } = await requireAdminScope(request, 'clans.view', {
    refresh: true,
    config: cfg,
  })

  const result = await listClans({
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
