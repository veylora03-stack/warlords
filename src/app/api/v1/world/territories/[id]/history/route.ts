/**
 * WARLORDS — GET /api/v1/world/territories/[id]/history (protected).
 *
 * The territory's APPEND-ONLY ownership history — an authenticated public
 * world record (owner ids/names are the same information the map exposes).
 * Contains NO private data: no armies, no wallets, no ledger rows.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { getTerritoryHistory } from '@/lib/game/services/world.service'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })
const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
})

export const GET = defineRoute(
  { params: paramsSchema, query: querySchema },
  async ({ request, params, query }) => {
    const env = getEnv()
    const cfg = resolveAuthConfig(env)
    const { refreshed } = await requirePlayer(request, {
      refresh: true,
      config: cfg,
      rateLimit: 'standard',
    })

    const view = await getTerritoryHistory(params.id, query.page ?? 1, query.pageSize ?? 20)

    const headers: Record<string, string> = {}
    if (refreshed) {
      headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
    }
    return ok(request, view, { headers })
  },
)
