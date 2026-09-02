/**
 * WARLORDS — POST /api/v1/clans/[id]/join (protected).
 *
 * Joins a clan. OPEN clans accept the join directly; INVITE_ONLY clans
 * require a PENDING, unexpired invitation id which is claimed exactly-once.
 * State-guarded replays land on typed 409s (ALREADY_IN_CLAN / CLAN_FULL /
 * CLAN_JOIN_POLICY_CLOSED / CLAN_INVITATION_INVALID).
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { joinClan } from '@/lib/game/services/clan.service'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })
const bodySchema = z.object({
  invitationId: z.string().min(1).max(64).optional(),
})

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

    const result = await joinClan(principal.player.id, params.id, body.invitationId)

    const headers: Record<string, string> = {}
    if (refreshed) {
      headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
    }
    return ok(request, result, { headers })
  },
)
