/**
 * WARLORDS — GET /api/v1/season (protected).
 *
 * Current season status (server-clock-resolved lifecycle), the season rules
 * (score sources · reward tiers · reset policy catalogs) and the caller's
 * standing (points · deterministic live rank · season wallet).
 * Read-only: no client input can mutate season state.
 */

import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { getSeasonView } from '@/lib/game/services/season.service'

export const GET = defineRoute({}, async ({ request }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, { refresh: true, config: cfg })

  const view = await getSeasonView(principal.player.id)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, view, { headers })
})
