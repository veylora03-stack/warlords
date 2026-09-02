/**
 * WARLORDS — POST /api/v1/clans/[id]/invite (protected, OFFICER+).
 *
 * Invites a player to the clan. Rank authorization is resolved server-side
 * (leader/officer only); the target must be clanless and the clan not full.
 * One live PENDING invitation per (clan, player) — a re-invite supersedes.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { inviteMember } from '@/lib/game/services/clan.service'

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

    const result = await inviteMember(principal.player.id, params.id, body.playerId)

    const headers: Record<string, string> = {}
    if (refreshed) {
      headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
    }
    return ok(request, result, { headers })
  },
)
