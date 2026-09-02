/**
 * WARLORDS — /api/v1/world/territories/[id]/garrison (protected).
 *
 * POST — deploy a positional detachment: DEFEND (own territory) or REINFORCE
 * (own or same-clan territory). This route is a THIN front for the ONE march
 * engine (createMarch): reservation, travel time, capacity, authorization
 * and idempotency are all owned by the march service — there is no second
 * deployment path.
 *
 * GET — the positional garrison view (strength, capacity, contributors).
 * Unit-level composition is filtered server-side (owner + contributors only).
 *
 * Refusals: TERRITORY_NOT_FOUND · MARCH_DESTINATION_NOT_OWNED ·
 * MARCH_GARRISON_FULL · MARCH_SLOTS_EXHAUSTED · INSUFFICIENT_UNITS ·
 * INSUFFICIENT_ENERGY · ACTION_ON_COOLDOWN · IDEMPOTENT_REPLAY (via march).
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { getTerritoryGarrisonView } from '@/lib/game/services/garrison.service'
import { createMarch } from '@/lib/game/services/march.service'
import { db } from '@/lib/db'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })
const bodySchema = z.object({
  type: z.enum(['DEFEND', 'REINFORCE']),
  units: z
    .array(z.object({ unitId: z.string().min(1).max(64), count: z.number().int().min(1) }))
    .min(1),
  idempotencyKey: z.string().min(1).max(64).optional(),
})

export const GET = defineRoute({ params: paramsSchema }, async ({ request, params }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, {
    refresh: true,
    config: cfg,
    rateLimit: 'standard',
  })

  const result = await getTerritoryGarrisonView(db, params.id, principal.player.id)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, result, { headers })
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

    // ONE march engine — deployment is a DEFEND/REINFORCE march, nothing else.
    const result = await createMarch(principal.player.id, {
      territoryId: params.id,
      type: body.type,
      units: body.units,
      idempotencyKey: body.idempotencyKey,
    })

    const headers: Record<string, string> = {}
    if (refreshed) {
      headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
    }
    return ok(request, result, { headers })
  },
)
