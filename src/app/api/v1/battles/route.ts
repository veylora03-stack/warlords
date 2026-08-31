/**
 * WARLORDS — GET /api/v1/battles (protected).
 *
 * The caller's battle history (as attacker AND defender), newest first,
 * with the caller-perspective outcome on every row.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { listPlayerBattles } from '@/lib/game/services/battle.service'

const historyQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
})

export const GET = defineRoute({ query: historyQuery }, async ({ request, query }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, {
    refresh: true,
    config: cfg,
  })

  const result = await listPlayerBattles(principal.player.id, query.page ?? 1, query.pageSize ?? 10)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }

  return ok(request, result, { headers })
})
