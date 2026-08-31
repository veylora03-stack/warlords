/**
 * WARLORDS — /api/v1/admin/staff (scope: staff.manage — ADMIN only).
 *
 * The RBAC control plane: list staff records, grant ADMIN/MODERATOR by
 * telegram id (upsert). The AdminUser row is the authorization the guard
 * resolves on EVERY admin request — grants/revokes take effect on the
 * staff member's next request. All grants are audited (STAFF_GRANT /
 * STAFF_ROLE_SET).
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { grantStaff, listStaff } from '@/lib/game/services/admin'
import { GRANTABLE_ADMIN_ROLES } from '@/lib/game/config/admin'
import { clientIp } from '@/lib/api/request-info'

const grantBody = z.object({
  telegramId: z.string().regex(/^\d{1,20}$/, 'telegramId must be numeric'),
  role: z.enum(GRANTABLE_ADMIN_ROLES),
})

export const GET = defineRoute({}, async ({ request }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { refreshed, adminUserId } = await requireAdminScope(request, 'staff.manage', {
    refresh: true,
    config: cfg,
    rateLimit: 'adminWrite',
  })

  const rows = await listStaff({ actorUserId: adminUserId })

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, { rows }, { headers })
})

export const POST = defineRoute({ body: grantBody }, async ({ request, body }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { refreshed, adminUserId } = await requireAdminScope(request, 'staff.manage', {
    refresh: true,
    config: cfg,
    rateLimit: 'adminWrite',
  })

  const result = await grantStaff({
    actorUserId: adminUserId,
    telegramId: body.telegramId,
    role: body.role,
    ip: clientIp(request),
  })

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, result, { headers })
})
