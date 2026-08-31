/**
 * WARLORDS — POST /api/v1/admin/events/:id/finish (scope: events.manage — ADMIN only).
 *
 * Ends a SCHEDULED/ACTIVE event (EVENT_FINISH). Conditional status claim —
 * concurrent operators converge; double-finish is EVENT_NOT_ACTIVE.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { finishEvent } from '@/lib/game/services/admin'
import { clientIp } from '@/lib/api/request-info'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })
const finishBody = z.object({ reason: z.string().min(1).max(300).optional() })

export const POST = defineRoute(
  { params: paramsSchema, body: finishBody },
  async ({ request, params, body }) => {
    const env = getEnv()
    const cfg = resolveAuthConfig(env)
    const { refreshed, adminUserId } = await requireAdminScope(request, 'events.manage', {
      refresh: true,
      config: cfg,
      rateLimit: 'adminWrite',
    })

    const row = await finishEvent({
      eventId: params.id,
      actorUserId: adminUserId,
      reason: body.reason,
      ip: clientIp(request),
    })

    const headers: Record<string, string> = {}
    if (refreshed) {
      headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
    }
    return ok(request, row, { headers })
  },
)
