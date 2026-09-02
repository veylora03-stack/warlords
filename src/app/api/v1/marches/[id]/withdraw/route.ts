/**
 * WARLORDS — POST /api/v1/marches/[id]/withdraw (protected, owner-only).
 *
 * Recalls a STATIONED positional detachment (march status ARRIVED) home.
 * Exactly-once: the conditional ARRIVED → RETURNING claim is the arbiter —
 * a battle that destroyed the contribution transitions the march to LOST
 * first, so dead troops can never be withdrawn.
 *
 * Refusals: MARCH_NOT_FOUND · MARCH_NOT_WITHDRAWABLE (409).
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { withdrawGarrison } from '@/lib/game/services/march.service'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export const POST = defineRoute({ params: paramsSchema }, async ({ request, params }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, {
    refresh: true,
    config: cfg,
    rateLimit: 'playerWrite',
  })

  const result = await withdrawGarrison(principal.player.id, params.id)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, result, { headers })
})
