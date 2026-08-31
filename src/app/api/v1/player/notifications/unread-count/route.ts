/**
 * WARLORDS — GET /api/v1/player/notifications/unread-count (protected).
 *
 * Cheap unread counter for the bell badge. Scoped to the session's own
 * player — the id comes from the principal, never from input.
 */

import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { countUnreadNotifications } from '@/lib/game/services/notification.service'

export const GET = defineRoute({}, async ({ request }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, { refresh: true, config: cfg })

  const unreadCount = await countUnreadNotifications(principal.player.id)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, { unreadCount }, { headers })
})
