/**
 * WARLORDS — GET /api/v1/world/player-territories (protected).
 *
 * The CALLER's own holdings (capital + conquered territories) with
 * server-computed production readiness. Strictly caller-scoped — no other
 * player's holdings are ever readable here.
 */

import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { getPlayerTerritories } from '@/lib/game/services/world.service'

export const GET = defineRoute({}, async ({ request }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, {
    refresh: true,
    config: cfg,
    rateLimit: 'standard',
  })

  const view = await getPlayerTerritories(principal.player.id)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, view, { headers })
})
