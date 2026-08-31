/**
 * WARLORDS — POST /api/v1/player/notifications/read (protected).
 *
 * Marks the caller's OWN inbox rows as read: `{ ids: [...] }` (bounded) or
 * `{ all: true }`. The player id comes from the session principal — a
 * client can never mark another player's rows, with or without ids.
 */

import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import {
  markNotificationsRead,
  markNotificationsReadSchema,
} from '@/lib/game/services/notification.service'

export const POST = defineRoute(
  { body: markNotificationsReadSchema },
  async ({ request, body }) => {
    const env = getEnv()
    const cfg = resolveAuthConfig(env)
    const { principal, refreshed } = await requirePlayer(request, {
      refresh: true,
      config: cfg,
      rateLimit: 'playerWrite',
    })

    const result = await markNotificationsRead(principal.player.id, body)

    const headers: Record<string, string> = {}
    if (refreshed) {
      headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
    }
    return ok(request, result, { headers })
  },
)
