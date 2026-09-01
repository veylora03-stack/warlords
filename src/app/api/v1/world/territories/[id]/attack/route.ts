/**
 * WARLORDS — POST /api/v1/world/territories/[id]/attack (protected).
 *
 * The ONLY territory combat write surface. The client supplies a territory id
 * and an optional idempotency key — NOTHING else: terrain, adjacency, seed,
 * garrison, casualties, spoils, capture and cooldown are computed server-side
 * inside one globally serialized transaction (NEVER TRUST THE CLIENT).
 *
 * Refusals (typed, zero writes): VALIDATION_ERROR · TERRITORY_NOT_FOUND ·
 * TERRITORY_OWNED · TERRITORY_CAPITAL_PROTECTED · TERRITORY_LOCKED ·
 * SEASON_NOT_ACTIVE · TERRITORY_NOT_ADJACENT · ACTION_ON_COOLDOWN ·
 * INSUFFICIENT_ENERGY · ARMY_EMPTY · IDEMPOTENT_REPLAY.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { attackTerritory } from '@/lib/game/services/world.service'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })
const bodySchema = z.object({
  // Optional client key for double-click/retry protection — semantics are
  // owned by the server (claim + replay of the original response).
  idempotencyKey: z.string().min(1).max(64).optional(),
})

export const POST = defineRoute(
  { params: paramsSchema, body: bodySchema },
  async ({ request, params, body }) => {
    const env = getEnv()
    const cfg = resolveAuthConfig(env)
    const { principal, refreshed } = await requirePlayer(request, {
      refresh: true,
      config: cfg,
      rateLimit: 'playerWrite',
    })

    const result = await attackTerritory(principal.player.id, {
      territoryId: params.id,
      idempotencyKey: body.idempotencyKey,
    })

    const headers: Record<string, string> = {}
    if (refreshed) {
      headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
    }
    return ok(request, result, { headers })
  },
)
