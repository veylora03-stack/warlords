/**
 * WARLORDS — GET /api/v1/city (protected).
 *
 * The authenticated player's city projection: every building with its level,
 * construction timers and server-computed effects, plus the aggregate
 * production/storage/queue state. READ-ONLY — construction mutations live on
 * the two POST endpoints and run server-side transactions.
 */

import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { db } from '@/lib/db'
import { getCityView } from '@/lib/game/services/city.service'

export const GET = defineRoute({}, async ({ request }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, { refresh: true, config: cfg })

  const city = await getCityView(db, principal.player.id)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }

  return ok(request, city, { headers })
})
