/**
 * WARLORDS — POST /api/v1/clans/[id]/members/[playerId]/role (protected).
 *
 * Promotes MEMBER → OFFICER or demotes OFFICER → MEMBER. LEADER-only,
 * self-change and LEADER-target are refused; the leadership path is
 * /transfer, never this route.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { setMemberRole } from '@/lib/game/services/clan.service'

const paramsSchema = z.object({
  id: z.string().min(1).max(64),
  playerId: z.string().min(1).max(64),
})
const bodySchema = z.object({ role: z.enum(['OFFICER', 'MEMBER']) })

export const POST = defineRoute(
  { params: paramsSchema, body: bodySchema },
  async ({ request, params, body }) => {
    const env = getEnv()
    const cfg = resolveAuthConfig(env)
    const { principal, refreshed } = await requirePlayer(request, {
      refresh: true,
      config: cfg,
      rateLimit: 'playerWrite',
    })

    const result = await setMemberRole(principal.player.id, params.id, params.playerId, body.role)

    const headers: Record<string, string> = {}
    if (refreshed) {
      headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
    }
    return ok(request, result, { headers })
  },
)
