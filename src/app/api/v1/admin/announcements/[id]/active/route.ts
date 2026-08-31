/**
 * WARLORDS — POST /api/v1/admin/announcements/:id/active (scope: announcements.manage — ADMIN only).
 *
 * Activates or deactivates an announcement (body {isActive: boolean}).
 * Audited (ANNOUNCE_ACTIVATE / ANNOUNCE_DEACTIVATE).
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { setAnnouncementActive } from '@/lib/game/services/admin'
import { clientIp } from '@/lib/api/request-info'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })
const activeBody = z.object({ isActive: z.boolean() })

export const POST = defineRoute(
  { params: paramsSchema, body: activeBody },
  async ({ request, params, body }) => {
    const env = getEnv()
    const cfg = resolveAuthConfig(env)
    const { refreshed, adminUserId } = await requireAdminScope(request, 'announcements.manage', {
      refresh: true,
      config: cfg,
    })

    const row = await setAnnouncementActive({
      announcementId: params.id,
      actorUserId: adminUserId,
      isActive: body.isActive,
      ip: clientIp(request),
    })

    const headers: Record<string, string> = {}
    if (refreshed) {
      headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
    }
    return ok(request, row, { headers })
  },
)
