/**
 * WARLORDS — GET /api/v1/admin/world/territories/[id] (scope: world.view).
 *
 * Full territory inspection for operators: world fields + recent ownership
 * history + garrison SIZE hint. Read-only; the inspection is itself audited
 * (privacy trail) best-effort.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { adminGetTerritory } from '@/lib/game/services/world.service'
import { recordAdminAuditView } from '@/lib/game/services/admin/admin-audit.service'
import { clientIp } from '@/lib/api/request-info'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export const GET = defineRoute({ params: paramsSchema }, async ({ request, params }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { refreshed, adminUserId } = await requireAdminScope(request, 'world.view', {
    refresh: true,
    config: cfg,
    rateLimit: 'adminRead',
  })

  const view = await adminGetTerritory(params.id)
  recordAdminAuditView({
    actorUserId: adminUserId,
    action: 'TERRITORY_INSPECT',
    targetType: 'territory',
    targetId: params.id,
    ip: clientIp(request),
  })

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, view, { headers })
})
