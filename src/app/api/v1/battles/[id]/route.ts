/**
 * WARLORDS — GET /api/v1/battles/[id] (protected).
 *
 * Full battle detail for a PARTICIPANT: stored result, round-by-round trace
 * (deterministic seed + config version included) and the caller's rendered
 * report. Non-participants are refused (the admin panel has its own
 * RBAC-guarded inspection surface).
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { getBattleForPlayer } from '@/lib/game/services/battle.service'

const detailParams = z.object({ id: z.string().min(1).max(64) })

export const GET = defineRoute({ params: detailParams }, async ({ request, params }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, {
    refresh: true,
    config: cfg,
  })

  const result = await getBattleForPlayer(principal.player.id, params.id)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }

  return ok(request, result, { headers })
})
