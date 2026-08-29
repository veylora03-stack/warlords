/**
 * WARLORDS — GET /api/v1/army/catalog (protected).
 *
 * The materialized unit catalog: the full Phase 7 roster with every unit's
 * stats, food upkeep, carry capacity, training cost, training time, counter
 * relationships and building gates. Pure config projection — the client
 * renders exact server numbers and never does authority math. Recruit is a
 * separate POST endpoint.
 */

import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { getArmyCatalogView } from '@/lib/game/services/army.service'

export const GET = defineRoute({}, async ({ request }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { refreshed } = await requirePlayer(request, { refresh: true, config: cfg })

  const catalog = await getArmyCatalogView()

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }

  return ok(request, catalog, { headers })
})
