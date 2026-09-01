/**
 * WARLORDS — GET /api/v1/quests (protected).
 *
 * The player's quest board: lazily expires stale instances, assigns every
 * eligible quest for the current cycle (unique-guarded), then projects the
 * catalog + the player's instances with server-computed eligibility and
 * progress. READ of PLAYER-OWNED data only — there is no client write
 * surface anywhere in the quest engine (progress arrives exclusively via
 * server-side domain events inside game transactions).
 *
 * ?filter=active|completed|claimable|all (default all) narrows the board.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { getQuestBoardView } from '@/lib/game/services/quest.service'

export const GET = defineRoute(
  {
    query: z.object({ filter: z.enum(['active', 'completed', 'claimable', 'all']).default('all') }),
  },
  async ({ request, query }) => {
    const env = getEnv()
    const cfg = resolveAuthConfig(env)
    const { principal, refreshed } = await requirePlayer(request, { refresh: true, config: cfg })

    const board = await getQuestBoardView(principal.player.id)
    const quests =
      query.filter === 'active'
        ? board.quests.filter((q) => q.instance?.status === 'ACTIVE')
        : query.filter === 'completed'
          ? board.quests.filter(
              (q) => q.instance?.status === 'COMPLETED' || q.instance?.status === 'CLAIMED',
            )
          : query.filter === 'claimable'
            ? board.quests.filter((q) => q.instance?.status === 'COMPLETED')
            : board.quests

    const headers: Record<string, string> = {}
    if (refreshed) {
      headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
    }

    return ok(request, { quests, counts: board.counts, filter: query.filter }, { headers })
  },
)
