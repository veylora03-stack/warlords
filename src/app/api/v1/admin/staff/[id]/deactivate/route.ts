/**
 * WARLORDS — POST /api/v1/admin/staff/:id/deactivate (scope: staff.manage — ADMIN only).
 *
 * Revokes a staff member's panel access (conditional isActive claim).
 * Self-deactivation is refused (SELF_TARGET) — no accidental lockouts.
 * Audited (STAFF_DEACTIVATE).
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { deactivateStaff } from '@/lib/game/services/admin'
import { clientIp } from '@/lib/api/request-info'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export const POST = defineRoute({ params: paramsSchema }, async ({ request, params }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { refreshed, adminUserId } = await requireAdminScope(request, 'staff.manage', {
    refresh: true,
    config: cfg,
    rateLimit: 'adminWrite',
  })

  const result = await deactivateStaff({
    actorUserId: adminUserId,
    adminUserId: params.id,
    ip: clientIp(request),
  })

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, result, { headers })
})
