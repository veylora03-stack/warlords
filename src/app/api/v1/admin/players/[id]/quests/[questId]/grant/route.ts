/**
 * WARLORDS — POST /api/v1/admin/players/[id]/quests/[questId]/grant
 * (scope: quests.manage).
 *
 * Marks the player's current instance COMPLETED (support tool). The reward
 * still flows through the NORMAL claim pipeline — this endpoint never injects
 * resources, so there is no reward-injection surface. Audited transactionally.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { adminGrantQuestCompletion } from '@/lib/game/services/quest.service'
import { clientIp } from '@/lib/api/request-info'

const paramsSchema = z.object({ id: z.string().min(1).max(64), questId: z.string().min(1).max(64) })
const bodySchema = z.object({
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

    const result = await adminGrantQuestCompletion({
      actorUserId: adminUserId,
      playerId: params.id,
      questId: params.questId,
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
