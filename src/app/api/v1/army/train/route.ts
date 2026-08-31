/**
 * WARLORDS — POST /api/v1/army/train (protected).
 *
 * Starts a recruitment batch. Server-side authority over EVERYTHING: the
 * unit must exist AND be active in the DB catalog, the quantity is capped by
 * config (negative/zero/fractional → typed 400), the training building must
 * exist at the catalog-required level, the FIFO queue depth is enforced, and
 * the batch cost is debited through the economy service INSIDE the same
 * per-player serialized transaction that appends the queue item — the client
 * can never set a count directly, only request one (NEVER TRUST THE CLIENT).
 *
 * Refusals (typed, zero writes): VALIDATION_ERROR · UNIT_NOT_FOUND ·
 * BUILDING_NOT_FOUND · PREREQUISITE_MISSING · TRAINING_QUEUE_FULL ·
 * INSUFFICIENT_*.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { recruitUnits } from '@/lib/game/services/army.service'

const trainBody = z.object({
  unitId: z.string().min(1).max(64),
  // Shape-level bounds here; the config ceiling is enforced in the service
  // (single policy authority — ARMY_TRAINING.maxUnitsPerBatch).
  count: z.number().int().min(1).max(1_000_000),
})

export const POST = defineRoute({ body: trainBody }, async ({ request, body }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, {
    refresh: true,
    config: cfg,
    rateLimit: 'playerWrite',
  })

  const result = await recruitUnits(principal.player.id, body.unitId, body.count)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }

  return ok(request, result, { headers })
})
