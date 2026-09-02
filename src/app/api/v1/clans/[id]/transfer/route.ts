/**
 * WARLORDS — POST /api/v1/clans/[id]/transfer (protected, LEADER only).
 *
 * Transfers leadership to a member. The swap (new LEADER + old OFFICER,
 * Clan.leaderPlayerId authority + denormalized mirrors) happens in ONE
 * transaction; every member gets one deduped CLAN_LEADERSHIP_CHANGED.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { transferLeadership } from '@/lib/game/services/clan.service'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })
const bodySchema = z.object({ playerId: z.string().min(1).max(64) })

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

    const result = await transferLeadership(principal.player.id, params.id, body.playerId)

    const headers: Record<string, string> = {}
    if (refreshed) {
      headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
    }
    return ok(request, result, { headers })
  },
)
