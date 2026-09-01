/**
 * WARLORDS — POST /api/v1/admin/players/[id]/quests/[questId]/reset
 * (scope: quests.manage).
 *
 * Deletes the player's quest instance(s) so the quest re-assigns cleanly.
 * Omit `cycle` to reset EVERY instance of the quest for the player.
 * Audited transactionally; reward rows already claimed are untouched.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { adminResetPlayerQuest } from '@/lib/game/services/quest.service'
import { clientIp } from '@/lib/api/request-info'

const paramsSchema = z.object({ id: z.string().min(1).max(64), questId: z.string().min(1).max(64) })
const bodySchema = z.object({
  cycle: z.string().min(1).max(32).optional(),
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

    const result = await adminResetPlayerQuest({
      actorUserId: adminUserId,
      playerId: params.id,
      questId: params.questId,
      cycle: body.cycle,
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
