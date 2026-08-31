/**
 * WARLORDS — GET /api/v1/admin/economy (scope: economy.view). READ-ONLY.
 *
 * Economy inspection: per-resource supply from real wallets, ledger flow by
 * reason over the policy window (mint/burn split), ledger shape and the
 * recent audited admin adjustments.
 */

import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { getEconomyOverview } from '@/lib/game/services/admin'
import { clientIp } from '@/lib/api/request-info'

export const GET = defineRoute({}, async ({ request }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { refreshed, adminUserId } = await requireAdminScope(request, 'economy.view', {
    refresh: true,
    config: cfg,
  })

  const overview = await getEconomyOverview({
    actorUserId: adminUserId,
    ip: clientIp(request),
  })

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, overview, { headers })
})
