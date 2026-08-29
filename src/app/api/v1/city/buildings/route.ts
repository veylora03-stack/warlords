/**
 * WARLORDS — GET /api/v1/city/buildings (protected).
 *
 * The materialized building catalog: all 17 types with every level's upgrade
 * cost, construction duration, requirements and effects. Pure config
 * projection — the client renders exact server numbers and never does
 * authority math. Upgrade/finish mutations are separate POST endpoints.
 */

import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { getBuildingCatalogView } from '@/lib/game/services/city.service'

export const GET = defineRoute({}, async ({ request }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { refreshed } = await requirePlayer(request, { refresh: true, config: cfg })

  const catalog = await getBuildingCatalogView()

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }

  return ok(request, catalog, { headers })
})
