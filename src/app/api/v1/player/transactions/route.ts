/**
 * WARLORDS — GET /api/v1/player/transactions (protected).
 *
 * The authenticated player's resource ledger history — newest first, keyset
 * paginated by (createdAt, id), optionally filtered by ledger reason. Rows
 * are append-only audit records: every economic delta with its reason,
 * signed delta (string) and resulting balance. Only the caller's OWN rows
 * are reachable; the player id comes from the session principal, never from
 * input.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { db } from '@/lib/db'
import { getTransactionHistory } from '@/lib/game/services/economy.service'
import { LEDGER_REASONS } from '@/lib/game/config/economy'

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(200).optional(),
  reason: z.enum(LEDGER_REASONS).optional(),
})

export const GET = defineRoute({ query: historyQuerySchema }, async ({ request, query }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, { refresh: true, config: cfg })

  const page = await getTransactionHistory(db, principal.player.id, {
    limit: query.limit,
    cursor: query.cursor ?? null,
    reason: query.reason,
  })

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }

  return ok(request, page, { headers })
})
