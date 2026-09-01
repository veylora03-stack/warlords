/**
 * WARLORDS — GET /api/v1/quests/[id] (protected).
 *
 * Single-quest detail: definition, server-computed progress, eligibility and
 * the claimable flag. The id is a catalog slug — another player's quest
 * state is unreachable by construction (every projection is scoped to the
 * authenticated principal's instances).
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { getQuestDetailView } from '@/lib/game/services/quest.service'

export const GET = defineRoute(
  { params: z.object({ id: z.string().min(1).max(64) }) },
  async ({ request, params }) => {
    const env = getEnv()
    const cfg = resolveAuthConfig(env)
    const { principal, refreshed } = await requirePlayer(request, { refresh: true, config: cfg })

    const detail = await getQuestDetailView(principal.player.id, params.id)

    const headers: Record<string, string> = {}
    if (refreshed) {
      headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
    }

    return ok(request, detail, { headers })
  },
)
