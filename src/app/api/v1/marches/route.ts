/**
 * WARLORDS — /api/v1/marches (protected).
 *
 * POST — create a march: the client supplies a destination territory, an
 * action, unit stacks and an optional idempotency key. EVERYTHING else
 * (origin, distance, speed, terrain, travel time, arrival, outcome) is
 * server-derived inside one globally serialized transaction.
 *
 * Refusals (typed, zero writes): VALIDATION_ERROR · MARCH_INVALID_UNITS ·
 * TERRITORY_NOT_FOUND · TERRITORY_LOCKED · TERRITORY_CAPITAL_PROTECTED ·
 * TERRITORY_OWNED · TERRITORY_NOT_ADJACENT · MARCH_DESTINATION_NOT_OWNED ·
 * MARCH_ORIGIN_NOT_FOUND · MARCH_SLOTS_EXHAUSTED · ACTION_ON_COOLDOWN ·
 * INSUFFICIENT_ENERGY · INSUFFICIENT_UNITS · SEASON_NOT_ACTIVE ·
 * IDEMPOTENT_REPLAY.
 *
 * GET — list the caller's marches (due marches are processed lazily first).
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { createMarch, listMarches } from '@/lib/game/services/march.service'
import { MARCH_TYPES } from '@/lib/game/types/common'

const bodySchema = z.object({
  territoryId: z.string().min(1).max(64),
  type: z.enum(MARCH_TYPES),
  units: z
    .array(z.object({ unitId: z.string().min(1).max(64), count: z.number().int().min(1) }))
    .min(1),
  idempotencyKey: z.string().min(1).max(64).optional(),
})

export const POST = defineRoute({ body: bodySchema }, async ({ request, body }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, {
    refresh: true,
    config: cfg,
    rateLimit: 'playerWrite',
  })

  const result = await createMarch(principal.player.id, {
    territoryId: body.territoryId,
    type: body.type,
    units: body.units,
    idempotencyKey: body.idempotencyKey,
  })

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, result, { headers })
})

export const GET = defineRoute({}, async ({ request }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, {
    refresh: true,
    config: cfg,
  })

  const result = await listMarches(principal.player.id)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, result, { headers })
})
