/**
 * WARLORDS — GET /api/v1/player/statistics (protected).
 *
 * The typed lifetime counter record (battles, economy, progression) from
 * the data-driven catalog in config/stats.ts. Counters are server-owned:
 * the only write path is recordPlayerStats inside game transactions.
 */

import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { db } from '@/lib/db'
import { getPlayerStatistics } from '@/lib/game/services/player-state.service'

export const GET = defineRoute({}, async ({ request }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, { refresh: true, config: cfg })

  const statistics = await getPlayerStatistics(db, principal.player.id)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }

  return ok(request, statistics, { headers })
})
