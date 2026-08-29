/**
 * WARLORDS — POST /api/v1/army/train/[id]/cancel (protected).
 *
 * Cancels a TRAINING batch with the policy-driven refund (config matrix:
 * 100% before the batch starts, 50% once under way) credited through the
 * ledger (reason UNIT_TRAINING, kind cancel_refund), then re-walks the
 * remaining FIFO queue so followers anchor as early as now — their paid
 * per-unit windows are preserved. Only the owner's rows are reachable and
 * resolved items refuse with TRAINING_NOT_ACTIVE.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { cancelTraining } from '@/lib/game/services/army.service'

export const POST = defineRoute(
  { params: z.object({ id: z.string().min(1).max(64) }) },
  async ({ request, params }) => {
    const env = getEnv()
    const cfg = resolveAuthConfig(env)
    const { principal, refreshed } = await requirePlayer(request, { refresh: true, config: cfg })

    const result = await cancelTraining(principal.player.id, params.id)

    const headers: Record<string, string> = {}
    if (refreshed) {
      headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
    }

    return ok(request, result, { headers })
  },
)
