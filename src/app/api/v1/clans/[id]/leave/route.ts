/**
 * WARLORDS — POST /api/v1/clans/[id]/leave (protected).
 *
 * Leaves the caller's clan. The LEADER cannot leave without transferring
 * leadership first (succession rule — a clan is never left leaderless).
 * Replays are state-guarded (NOT_IN_CLAN 409).
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { leaveClan } from '@/lib/game/services/clan.service'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export const POST = defineRoute({ params: paramsSchema }, async ({ request, params }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, {
    refresh: true,
    config: cfg,
    rateLimit: 'playerWrite',
  })

  // The clan id in the path is cross-checked against the caller's membership
  // inside the service (a mismatch is a typed 409, never a partial write).
  const result = await leaveClan(principal.player.id, params.id)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, result, { headers })
})
