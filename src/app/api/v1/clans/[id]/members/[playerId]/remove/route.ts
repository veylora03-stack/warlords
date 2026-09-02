/**
 * WARLORDS — POST /api/v1/clans/[id]/members/[playerId]/remove (protected).
 *
 * Removes a MEMBER from the clan. OFFICER+ authorization, rank matrix and
 * the leader-protection rule are resolved server-side (typed 403/409).
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { removeMember } from '@/lib/game/services/clan.service'

const paramsSchema = z.object({
  id: z.string().min(1).max(64),
  playerId: z.string().min(1).max(64),
})

export const POST = defineRoute({ params: paramsSchema }, async ({ request, params }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, {
    refresh: true,
    config: cfg,
    rateLimit: 'playerWrite',
  })

  const result = await removeMember(principal.player.id, params.id, params.playerId)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, result, { headers })
})
