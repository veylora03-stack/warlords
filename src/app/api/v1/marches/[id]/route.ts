/**
 * WARLORDS — GET /api/v1/marches/[id] (protected, owner-only).
 *
 * One march's server-authoritative state. A foreign march id is a NOT_FOUND
 * (no existence leak). The march is processed first if the SERVER clock says
 * it is due — the client can never decide that a march has arrived.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { getMarch } from '@/lib/game/services/march.service'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export const GET = defineRoute({ params: paramsSchema }, async ({ request, params }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, {
    refresh: true,
    config: cfg,
  })

  const result = await getMarch(principal.player.id, params.id)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, result, { headers })
})
