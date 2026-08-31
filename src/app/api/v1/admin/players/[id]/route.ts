/**
 * WARLORDS — GET /api/v1/admin/players/:id (scope: players.view).
 *
 * Full player inspection: identity + ban state, wallet, city, army, ledger
 * tail, battle tail. Read-only but AUDITED (VIEW_PLAYER_DETAILS) — privacy
 * trail for every inspection.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { getPlayerDetails } from '@/lib/game/services/admin'
import { clientIp } from '@/lib/api/request-info'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export const GET = defineRoute({ params: paramsSchema }, async ({ request, params }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { refreshed, adminUserId } = await requireAdminScope(request, 'players.view', {
    refresh: true,
    config: cfg,
  })

  const details = await getPlayerDetails({
    playerId: params.id,
    actorUserId: adminUserId,
    ip: clientIp(request),
  })

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, details, { headers })
})
