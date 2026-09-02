/**
 * WARLORDS — POST /api/v1/world/territories/[id]/garrison/withdraw (protected).
 *
 * Recalls one of the caller's stationed detachments from this territory.
 * The marchId in the body is cross-checked against the territory id in the
 * path server-side — a mismatched pair is a typed 404 (no leak, no write).
 * Exactly-once restoration rides the march return leg.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { AppError } from '@/lib/api/errors'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { withdrawGarrison } from '@/lib/game/services/march.service'
import { db } from '@/lib/db'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })
const bodySchema = z.object({ marchId: z.string().min(1).max(64) })

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

    // Path/body coherence: the march must be stationed on THIS territory.
    // Foreign march ids are a NOT_FOUND — never a leak (Phase 33 rule).
    const march = await db.march.findUnique({
      where: { id: body.marchId },
      select: { playerId: true, territoryId: true, status: true },
    })
    if (
      !march ||
      march.playerId !== principal.player.id ||
      march.territoryId !== params.id ||
      march.status !== 'ARRIVED'
    ) {
      throw new AppError(
        'MARCH_NOT_FOUND',
        'No stationed detachment of yours on this territory',
      )
    }

    const result = await withdrawGarrison(principal.player.id, body.marchId)

    const headers: Record<string, string> = {}
    if (refreshed) {
      headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
    }
    return ok(request, result, { headers })
  },
)
