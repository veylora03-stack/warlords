/**
 * WARLORDS — GET /api/v1/player/resources (protected).
 *
 * The authenticated player's six-resource wallet projection: balances, caps
 * and headroom as display strings (BigInt policy), in canonical economy
 * order. READ-ONLY — there is deliberately no client-write surface for
 * resources anywhere in the API; every mutation flows through the economy
 * service inside server-owned transactions.
 */

import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { db } from '@/lib/db'
import { getWalletView } from '@/lib/game/services/economy.service'

export const GET = defineRoute({}, async ({ request }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, { refresh: true, config: cfg })

  const wallet = await getWalletView(db, principal.player.id)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }

  return ok(request, wallet, { headers })
})
