/**
 * WARLORDS — POST /api/v1/admin/announcements/:id/broadcast (scope: announcements.manage — ADMIN only).
 *
 * Fans the (active) announcement out into EVERY audience player's
 * notification inbox inside ONE transaction — the count lands on the audit
 * row (ANNOUNCE_BROADCAST). Inactive announcements are refused.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { broadcastAnnouncement } from '@/lib/game/services/admin'
import { clientIp } from '@/lib/api/request-info'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export const POST = defineRoute({ params: paramsSchema }, async ({ request, params }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { refreshed, adminUserId } = await requireAdminScope(request, 'announcements.manage', {
    refresh: true,
    config: cfg,
    rateLimit: 'adminBroadcast',
  })

  const result = await broadcastAnnouncement({
    announcementId: params.id,
    actorUserId: adminUserId,
    ip: clientIp(request),
  })

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, result, { headers })
})
