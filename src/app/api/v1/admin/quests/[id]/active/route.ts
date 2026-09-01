/**
 * WARLORDS — POST /api/v1/admin/quests/[id]/active (scope: quests.manage).
 *
 * Enables/disables a quest definition. Deactivation removes the quest from
 * assignment sweeps and event matching WITHOUT touching existing instances
 * (an operator pause, not a wipe). Audited transactionally.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { adminSetQuestActive } from '@/lib/game/services/quest.service'
import { clientIp } from '@/lib/api/request-info'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })
const bodySchema = z.object({
  isActive: z.boolean(),
  reason: z.string().min(4).max(300).optional(),
})

export const POST = defineRoute(
  { params: paramsSchema, body: bodySchema },
  async ({ request, params, body }) => {
    const env = getEnv()
    const cfg = resolveAuthConfig(env)
    const { refreshed, adminUserId } = await requireAdminScope(request, 'quests.manage', {
      refresh: true,
      config: cfg,
      rateLimit: 'adminWrite',
    })

    const result = await adminSetQuestActive({
      actorUserId: adminUserId,
      questId: params.id,
      isActive: body.isActive,
      reason: body.reason,
      ip: clientIp(request),
    })

    const headers: Record<string, string> = {}
    if (refreshed) {
      headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
    }
    return ok(request, result, { headers })
  },
)
