/**
 * WARLORDS — GET /api/v1/quests/achievements (protected).
 *
 * The permanent achievement board: unlocked + locked, live progress where
 * the metric is player-visible, unlock dates and rewards. Achievements are
 * evaluated server-side from persisted state — nothing here is claimable or
 * client-influenced; unlocks arrive automatically inside game transactions.
 */

import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { listAchievementsView } from '@/lib/game/services/achievement.service'

export const GET = defineRoute({}, async ({ request }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, { refresh: true, config: cfg })

  const board = await listAchievementsView(principal.player.id)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }

  return ok(request, board, { headers })
})
