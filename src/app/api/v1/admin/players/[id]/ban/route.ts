/**
 * WARLORDS — POST /api/v1/admin/players/:id/ban (scope: players.ban).
 *
 * Bans the player's account. Enforcement lives in the session service
 * (assertNotBanned on EVERY authenticated request — DB is the per-request
 * authority), so the ban takes effect on the player's very next request.
 * Reason is REQUIRED (operator accountability); optional temp-ban horizon.
 * The audit row commits in the SAME transaction as the ban.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { banPlayer } from '@/lib/game/services/admin'
import { clientIp } from '@/lib/api/request-info'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })
const banBody = z.object({
  reason: z.string().min(4).max(300),
  /** Optional temporary ban — ISO timestamp in the future. */
  expiresAt: z.coerce
    .date()
    .refine((d) => d.getTime() > Date.now(), {
      message: 'expiresAt must be in the future',
    })
    .optional(),
})

export const POST = defineRoute(
  { params: paramsSchema, body: banBody },
  async ({ request, params, body }) => {
    const env = getEnv()
    const cfg = resolveAuthConfig(env)
    const { refreshed, adminUserId } = await requireAdminScope(request, 'players.ban', {
      refresh: true,
      config: cfg,
    })

    const result = await banPlayer({
      playerId: params.id,
      actorUserId: adminUserId,
      reason: body.reason,
      expiresAt: body.expiresAt,
      ip: clientIp(request),
    })

    const headers: Record<string, string> = {}
    if (refreshed) {
      headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
    }
    return ok(request, result, { headers })
  },
)
