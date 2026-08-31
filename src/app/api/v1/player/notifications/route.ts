/**
 * WARLORDS — GET /api/v1/player/notifications (protected).
 *
 * The authenticated player's notification inbox — newest first, optionally
 * unread-only. Every row was rendered server-side by the notification
 * engine's catalog (payload validated at enqueue); the client renders the
 * delivered title/body and may deep-link through `data`.
 */

import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { listPlayerNotifications } from '@/lib/game/services/notification.service'

export const GET = defineRoute({}, async ({ request }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, { refresh: true, config: cfg })

  const url = new URL(request.url)
  const page = await listPlayerNotifications(principal.player.id, {
    limit: url.searchParams.get('limit') ?? undefined,
    unreadOnly: url.searchParams.get('unreadOnly') ?? undefined,
  })

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, page, { headers })
})
