/**
 * WARLORDS — POST /api/v1/admin/notifications/worker/tick (ADMIN ONLY).
 *
 * Synchronous drain of the notification queue — the same code path the
 * in-process worker (instrumentation boot) runs on its interval. Operators
 * use it to flush the queue on demand; tests drive it (or the service
 * directly) for deterministic timing. The background loop remains the
 * production driver; this endpoint is an operator/CI lever, never the only
 * drain path.
 *
 * 403 ADMIN_REQUIRED / ADMIN_FORBIDDEN — the RBAC scope `notifications.drain`
 * resolves through the server-side matrix, not any frontend state.
 */

import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import {
  drainNotificationQueue,
  pruneNotificationStorage,
} from '@/lib/game/services/notification.service'
import { pruneExpiredIdempotencyKeys } from '@/lib/game/services/economy.service'
import { enforcePrincipalRateLimit } from '@/lib/rate-limit'

export const POST = defineRoute({}, async ({ request }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { refreshed, principal } = await requireAdminScope(request, 'notifications.drain', {
    refresh: true,
    config: cfg,
  })
  enforcePrincipalRateLimit(principal.user.id, 'adminDrain')

  const result = await drainNotificationQueue({ workerId: 'admin-tick' })
  const prune = await pruneNotificationStorage()
  const idempotencyKeysPruned = await pruneExpiredIdempotencyKeys()

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, { ...result, pruned: prune, idempotencyKeysPruned }, { headers })
})
