/**
 * WARLORDS — GET /api/v1/world/territories/[id] (protected).
 *
 * Territory detail — public world knowledge only. Includes the server-
 * computed attackability verdict for the CALLER (the client never decides
 * attackability) and, for own producing territories, the lazy-production
 * readiness. The defender's private army composition is NEVER included.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { getTerritoryDetail } from '@/lib/game/services/world.service'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export const GET = defineRoute({ params: paramsSchema }, async ({ request, params }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, {
    refresh: true,
    config: cfg,
    rateLimit: 'standard',
  })

  const detail = await getTerritoryDetail(principal.player.id, params.id)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, detail, { headers })
})
