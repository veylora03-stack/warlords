/**
 * WARLORDS — POST /api/v1/admin/players/:id/unban (scope: players.unban).
 *
 * Lifts a ban. Refused with PLAYER_NOT_BANNED when there is nothing to
 * lift. Audited (UNBAN) transactionally.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { unbanPlayer } from '@/lib/game/services/admin'
import { clientIp } from '@/lib/api/request-info'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })
const unbanBody = z.object({ note: z.string().min(1).max(300).optional() })

export const POST = defineRoute(
  { params: paramsSchema, body: unbanBody },
  async ({ request, params, body }) => {
    const env = getEnv()
    const cfg = resolveAuthConfig(env)
    const { refreshed, adminUserId } = await requireAdminScope(request, 'players.unban', {
      refresh: true,
      config: cfg,
      rateLimit: 'adminWrite',
    })

    const result = await unbanPlayer({
      playerId: params.id,
      actorUserId: adminUserId,
      note: body.note,
      ip: clientIp(request),
    })

    const headers: Record<string, string> = {}
    if (refreshed) {
      headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
    }
    return ok(request, result, { headers })
  },
)
