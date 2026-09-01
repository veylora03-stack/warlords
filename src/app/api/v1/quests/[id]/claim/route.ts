/**
 * WARLORDS — POST /api/v1/quests/[id]/claim (protected).
 *
 * Claims the reward of a completed quest. THE claim is the only player-
 * triggered mutation in the quest engine, and it can only ever:
 *   - target the AUTHENTICATED player's own instance (playerId from the
 *     session, never from the body),
 *   - succeed for a COMPLETED instance (guarded status transition — the DB
 *     is the exactly-once arbiter; concurrent/duplicate claims get 409),
 *   - pay the SERVER-DEFINED reward through the Economy/Ledger +
 *     progression rails (the client cannot influence the amounts).
 *
 * Refusals (typed): QUEST_NOT_FOUND · QUEST_NOT_COMPLETED ·
 * QUEST_ALREADY_CLAIMED · QUEST_EXPIRED.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { claimQuest } from '@/lib/game/services/quest.service'

export const POST = defineRoute(
  { params: z.object({ id: z.string().min(1).max(64) }) },
  async ({ request, params }) => {
    const env = getEnv()
    const cfg = resolveAuthConfig(env)
    const { principal, refreshed } = await requirePlayer(request, {
      refresh: true,
      config: cfg,
      rateLimit: 'playerWrite',
    })

    const result = await claimQuest(principal.player.id, params.id)

    const headers: Record<string, string> = {}
    if (refreshed) {
      headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
    }

    return ok(request, result, { headers })
  },
)
