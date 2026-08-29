/**
 * WARLORDS — GET /api/v1/player/profile (protected).
 *
 * The player's progression snapshot: level + XP curve position, honor,
 * reputation, season points, lazily-regenerated energy, and freshly
 * computed power (with its source breakdown). Power is NEVER read from a
 * client-supplied value — it is recomputed from real state on every call.
 */

import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { db } from '@/lib/db'
import { getPlayerProfile } from '@/lib/game/services/player-state.service'

export const GET = defineRoute({}, async ({ request }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, { refresh: true, config: cfg })

  const profile = await getPlayerProfile(db, principal.player.id)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }

  return ok(request, profile, { headers })
})
