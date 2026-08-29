/**
 * WARLORDS — GET /api/v1/army (protected).
 *
 * Server-owned army projection: the full active roster joined with the
 * player's real stacks, aggregate upkeep/carry totals and the live training
 * queue with server-clock-derived statuses. No client input beyond the
 * authenticated principal.
 */

import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { db } from '@/lib/db'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { getArmyView } from '@/lib/game/services/army.service'

export const GET = defineRoute({}, async ({ request }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, { refresh: true, config: cfg })

  const army = await getArmyView(db, principal.player.id)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }

  return ok(request, army, { headers })
})
