/**
 * WARLORDS — POST /api/v1/battles/attack (protected).
 *
 * The ONLY combat write surface. The client supplies a target player id and
 * an optional idempotency key — NOTHING else: armies, seed, casualties,
 * loot, rewards and cooldown are computed server-side inside one globally
 * serialized transaction (NEVER TRUST THE CLIENT).
 *
 * Refusals (typed, zero writes): VALIDATION_ERROR · SELF_TARGET ·
 * PLAYER_NOT_FOUND · INVALID_TARGET · SEASON_NOT_ACTIVE ·
 * ACTION_ON_COOLDOWN · PROTECTED_TARGET · INSUFFICIENT_ENERGY · ARMY_EMPTY ·
 * IDEMPOTENT_REPLAY.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { attack } from '@/lib/game/services/battle.service'

const attackBody = z.object({
  targetPlayerId: z.string().min(1).max(64),
  // Optional client key for double-click/retry protection — semantics are
  // owned by the server (claim + replay of the original response).
  idempotencyKey: z.string().min(1).max(64).optional(),
})

export const POST = defineRoute({ body: attackBody }, async ({ request, body }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, {
    refresh: true,
    config: cfg,
    rateLimit: 'playerWrite',
  })

  const result = await attack(principal.player.id, {
    targetPlayerId: body.targetPlayerId,
    idempotencyKey: body.idempotencyKey,
  })

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }

  return ok(request, result, { headers })
})
