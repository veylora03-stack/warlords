/**
 * WARLORDS — POST /api/v1/admin/season/settle/simulate (ADMIN ONLY).
 *
 * DRY-RUN of the season reset: the identical settlement code path executes
 * inside a transaction that is ALWAYS rolled back — the response is a full
 * report of what WOULD happen (final ranking, reward tiers, wipe counts,
 * permanent grants, next season) while NOTHING persists. Operators review
 * this report before executing the real reset.
 *
 * 403 ADMIN_REQUIRED for any authenticated non-admin — settlement is never
 * client-drivable.
 */

import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { simulateSeasonSettlement } from '@/lib/game/services/season-settlement.service'

export const POST = defineRoute({}, async ({ request }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { refreshed } = await requireAdminScope(request, 'season.settle', {
    refresh: true,
    config: cfg,
    rateLimit: 'adminSettle',
  })

  const report = await simulateSeasonSettlement()

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, report, { headers })
})
