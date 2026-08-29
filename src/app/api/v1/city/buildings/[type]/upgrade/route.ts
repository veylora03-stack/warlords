/**
 * WARLORDS — POST /api/v1/city/buildings/[type]/upgrade (protected).
 *
 * Starts a building upgrade. Server-side authority over EVERYTHING: the
 * type must exist in the catalog, the target level/cost/duration come from
 * config, requirements are evaluated against real DB state, and the cost is
 * debited through the economy service INSIDE the same per-player serialized
 * transaction that records the construction timer — double-spending is
 * structurally impossible (mutex + validate-ALL-then-write + conditional
 * compare-and-decrement + conditional construction claim).
 *
 * Refusals (typed, zero writes): BUILDING_NOT_FOUND · CONSTRUCTION_IN_PROGRESS ·
 * MAX_LEVEL_REACHED · PREREQUISITE_MISSING · BUILDING_QUEUE_BUSY · INSUFFICIENT_*.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { startBuildingUpgrade } from '@/lib/game/services/city.service'

export const POST = defineRoute(
  { params: z.object({ type: z.string().min(1).max(32) }) },
  async ({ request, params }) => {
    const env = getEnv()
    const cfg = resolveAuthConfig(env)
    const { principal, refreshed } = await requirePlayer(request, { refresh: true, config: cfg })

    const result = await startBuildingUpgrade(principal.player.id, params.type)

    const headers: Record<string, string> = {}
    if (refreshed) {
      headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
    }

    return ok(request, result, { headers })
  },
)
