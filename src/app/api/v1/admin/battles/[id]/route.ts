/**
 * WARLORDS — GET /api/v1/admin/battles/:id (scope: battles.view). READ-ONLY.
 *
 * Full battle inspection: participants, deterministic seed/configVersion,
 * powers, loot, the complete round trace and per-participant reports.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { getBattleDetail } from '@/lib/game/services/admin'
import { clientIp } from '@/lib/api/request-info'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export const GET = defineRoute({ params: paramsSchema }, async ({ request, params }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { refreshed, adminUserId } = await requireAdminScope(request, 'battles.view', {
    refresh: true,
    config: cfg,
  })

  const detail = await getBattleDetail({
    battleId: params.id,
    actorUserId: adminUserId,
    ip: clientIp(request),
  })

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, detail, { headers })
})
