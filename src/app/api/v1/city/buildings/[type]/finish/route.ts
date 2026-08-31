/**
 * WARLORDS — POST /api/v1/city/buildings/[type]/finish (protected).
 *
 * Claims a finished construction. The SERVER clock is the only timing
 * authority: a claim before `upgradeCompletesAt` is refused with
 * CONSTRUCTION_NOT_COMPLETE (remaining seconds in the details). The level
 * application is a conditional update guarded on the in-flight state, the
 * completion notification is written, and power is recalculated from the
 * real state — all inside one serialized transaction. Retrying after a
 * successful claim is a typed CONSTRUCTION_NOT_ACTIVE (idempotent in
 * effect: the level can never be applied twice).
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { finishBuildingUpgrade } from '@/lib/game/services/city.service'

export const POST = defineRoute(
  { params: z.object({ type: z.string().min(1).max(32) }) },
  async ({ request, params }) => {
    const env = getEnv()
    const cfg = resolveAuthConfig(env)
    const { principal, refreshed } = await requirePlayer(request, {
      refresh: true,
      config: cfg,
      rateLimit: 'playerWrite',
    })

    const result = await finishBuildingUpgrade(principal.player.id, params.type)

    const headers: Record<string, string> = {}
    if (refreshed) {
      headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
    }

    return ok(request, result, { headers })
  },
)
