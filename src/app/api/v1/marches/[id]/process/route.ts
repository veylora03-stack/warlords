/**
 * WARLORDS — POST /api/v1/marches/[id]/process (protected, owner-only).
 *
 * Server-authoritative progress check. Processes the march when the SERVER
 * clock says it is due (arrival → assault/scout/delivery; return →
 * homecoming); otherwise an idempotent no-op carrying the current state.
 * The client may trigger this at will — it can never make a march arrive
 * early, and double-processing is impossible (conditional status claims).
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { processMarch } from '@/lib/game/services/march.service'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export const POST = defineRoute({ params: paramsSchema }, async ({ request, params }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, {
    refresh: true,
    config: cfg,
    rateLimit: 'playerWrite',
  })

  const result = await processMarch(principal.player.id, params.id)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, result, { headers })
})
