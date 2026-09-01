/**
 * WARLORDS — POST /api/v1/marches/[id]/cancel (protected, owner-only).
 *
 * Recalls a march that is still EN_ROUTE. Exactly-once by a conditional
 * status claim (the arrival processor's claim is the race arbiter — whoever
 * claims first decides). The reservation manifest is restored in full;
 * mobilization energy is NEVER refunded (documented policy).
 *
 * Refusals: MARCH_NOT_FOUND · MARCH_NOT_CANCELLABLE (409).
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { cancelMarch } from '@/lib/game/services/march.service'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export const POST = defineRoute({ params: paramsSchema }, async ({ request, params }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, {
    refresh: true,
    config: cfg,
    rateLimit: 'playerWrite',
  })

  const result = await cancelMarch(principal.player.id, params.id)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, result, { headers })
})
