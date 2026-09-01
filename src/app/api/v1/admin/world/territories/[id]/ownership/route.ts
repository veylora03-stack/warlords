/**
 * WARLORDS — POST /api/v1/admin/world/territories/[id]/ownership (scope: world.manage).
 *
 * Operator ownership correction. Grants to a player (status → CONTROLLED) or
 * strips to unclaimed (ownerId null). Capitals are IMMUTABLE — a capital's
 * ownership can never be reassigned. Lands an append-only TerritoryHistory
 * row (reason ADMIN) + a transactional audit entry with before/after.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { adminSetTerritoryOwnership } from '@/lib/game/services/world.service'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })
const bodySchema = z.object({
  ownerId: z.string().min(1).max(64).nullable(),
  reason: z.string().min(4).max(300),
})

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

    const result = await adminSetTerritoryOwnership(
      adminUserId,
      params.id,
      body.ownerId,
      body.reason,
    )

    const headers: Record<string, string> = {}
    if (refreshed) {
      headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
    }
    return ok(request, result, { headers })
  },
)
