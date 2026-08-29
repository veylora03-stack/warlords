/**
 * WARLORDS — POST /api/v1/army/train/[id]/complete (protected).
 *
 * Claims a finished training batch. The SERVER clock is the only timing
 * authority — an early claim is refused with TRAINING_NOT_COMPLETE and the
 * remaining seconds; the claim itself is a conditional update guarded on
 * status=TRAINING (a concurrent cancel/claim loses with TRAINING_NOT_ACTIVE).
 * On success the units land via upsert-increment, power is recalculated from
 * real state, and a TRAINING_COMPLETE notification is written — all in one
 * transaction. Only the owner's queue rows are reachable.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { completeTraining } from '@/lib/game/services/army.service'

export const POST = defineRoute(
  { params: z.object({ id: z.string().min(1).max(64) }) },
  async ({ request, params }) => {
    const env = getEnv()
    const cfg = resolveAuthConfig(env)
    const { principal, refreshed } = await requirePlayer(request, { refresh: true, config: cfg })

    const result = await completeTraining(principal.player.id, params.id)

    const headers: Record<string, string> = {}
    if (refreshed) {
      headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
    }

    return ok(request, result, { headers })
  },
)
