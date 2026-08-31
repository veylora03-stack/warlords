/**
 * WARLORDS — GET /api/v1/season/progression (protected).
 *
 * The caller's PERMANENT progression — titles, cosmetics, achievements and
 * commanders (each commander flagged seasonal vs permanent) — exactly the
 * state that survives every season reset. Read-only.
 */

import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { getSeasonProgressionView } from '@/lib/game/services/season.service'

export const GET = defineRoute({}, async ({ request }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, { refresh: true, config: cfg })

  const view = await getSeasonProgressionView(principal.player.id)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, view, { headers })
})
