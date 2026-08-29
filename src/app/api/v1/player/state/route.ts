/**
 * WARLORDS — GET /api/v1/player/state (protected).
 *
 * The full Mini App bootstrap payload in ONE call: profile (progression +
 * power + energy) plus wallet balances (ledger-backed), the capital city,
 * building count, and the army roster. Every amount is a string (BigInt
 * policy) and every value is derived server-side — never client input.
 */

import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { db } from '@/lib/db'
import { getPlayerState } from '@/lib/game/services/player-state.service'

export const GET = defineRoute({}, async ({ request }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, { refresh: true, config: cfg })

  const state = await getPlayerState(db, principal.player.id)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }

  return ok(request, state, { headers })
})
