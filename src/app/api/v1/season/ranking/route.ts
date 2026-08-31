/**
 * WARLORDS — GET /api/v1/season/ranking (protected).
 *
 * Seasonal ranking. For the RUNNING season the ranking is computed
 * SERVER-SIDE from the real season points (deterministic order: points
 * desc, then id asc for ties). Settled seasons expose their materialized
 * Leaderboard history via ?seasonId= — refused with SEASON_NOT_SETTLED for
 * seasons whose reset has not run (no final ranking exists yet).
 * Query: limit (1…100, default 10) · seasonId (optional history selector).
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { getSeasonRankingView } from '@/lib/game/services/season.service'

const rankingQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
  seasonId: z.string().min(1).max(64).optional(),
})

export const GET = defineRoute({ query: rankingQuery }, async ({ request, query }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, { refresh: true, config: cfg })

  const view = await getSeasonRankingView(principal.player.id, query.limit, query.seasonId)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, view, { headers })
})
