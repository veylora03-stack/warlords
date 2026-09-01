/**
 * WARLORDS — POST /api/v1/admin/world/territories/[id]/lock (scope: world.manage).
 *
 * Locks/unlocks a territory. LOCKED cells are unattackable and uncollectible;
 * unlocking restores CONTROLLED (when owned) or UNCLAIMED. Capitals can never
 * be locked. Audited transactionally.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { adminSetTerritoryLock } from '@/lib/game/services/world.service'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })
const bodySchema = z.object({ locked: z.boolean() })

export const POST = defineRoute(
  { params: paramsSchema, body: bodySchema },
  async ({ request, params, body }) => {
    const env = getEnv()
    const cfg = resolveAuthConfig(env)
    const { refreshed, adminUserId } = await requireAdminScope(request, 'world.manage', {
      refresh: true,
      config: cfg,
      rateLimit: 'adminWrite',
    })

    const result = await adminSetTerritoryLock(adminUserId, params.id, body.locked)

    const headers: Record<string, string> = {}
    if (refreshed) {
      headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
    }
    return ok(request, result, { headers })
  },
)
