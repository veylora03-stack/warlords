/**
 * WARLORDS — POST /api/v1/world/territories/[id]/collect (protected).
 *
 * Lazy production collection for an OWNED producing territory. The amount is
 * computed SERVER-side (rate × elapsed × terrain multiplier, capped); the
 * credit flows through the EXISTING ledger (TERRITORY_PRODUCTION). Double
 * collection is structurally impossible (cursor advanced in the same tx).
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { collectTerritoryProduction } from '@/lib/game/services/world.service'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export const POST = defineRoute({ params: paramsSchema }, async ({ request, params }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, {
    refresh: true,
    config: cfg,
    rateLimit: 'playerWrite',
  })

  const result = await collectTerritoryProduction(principal.player.id, params.id)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, result, { headers })
})
