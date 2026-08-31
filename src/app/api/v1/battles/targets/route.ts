/**
 * WARLORDS — GET /api/v1/battles/targets (protected).
 *
 * The scouting surface for the attack screen: the caller's attack readiness
 * (energy, cooldown, army size) and a PUBLIC roster of other players — name,
 * level, power, honor, reputation, protection status. Defender ARMIES are
 * hidden information and are never included.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { listTargets } from '@/lib/game/services/battle.service'

const targetsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
})

export const GET = defineRoute({ query: targetsQuery }, async ({ request, query }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, {
    refresh: true,
    config: cfg,
  })

  const result = await listTargets(principal.player.id, query.limit ?? 20)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }

  return ok(request, result, { headers })
})
