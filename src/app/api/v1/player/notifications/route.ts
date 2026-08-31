/**
 * WARLORDS — GET /api/v1/player/notifications (protected).
 *
 * The authenticated player's notification inbox — newest first, optionally
 * unread-only. Every row was rendered server-side by the notification
 * engine's catalog (payload validated at enqueue); the client renders the
 * delivered title/body and may deep-link through `data`.
 *
 * Phase 23: the query is parsed through the defineRoute spec so malformed
 * input is a typed 400 VALIDATION_ERROR envelope (previously the raw
 * ZodError escaped the AppError taxonomy as a 500).
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { listPlayerNotifications } from '@/lib/game/services/notification.service'
import { NOTIFICATION_POLICY } from '@/lib/game/config/notifications'

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(NOTIFICATION_POLICY.listMaxLimit).optional(),
  unreadOnly: z.enum(['true', 'false']).optional(),
})

export const GET = defineRoute({ query: listQuery }, async ({ request, query }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, { refresh: true, config: cfg })

  const page = await listPlayerNotifications(principal.player.id, {
    limit: query.limit,
    unreadOnly:
      query.unreadOnly === 'true' ? true : query.unreadOnly === 'false' ? false : undefined,
  })

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, page, { headers })
})
