/**
 * WARLORDS — GET /api/v1/world/map (protected).
 *
 * Viewport world map. The client MAY supply bounds (minX/maxX/minY/maxY);
 * the server clamps them to the world grid, enforces the viewport area cap
 * (the full world is NEVER serialized), and — when no bounds are sent —
 * picks the viewport around the caller's capital itself.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { getWorldMap } from '@/lib/game/services/world.service'

const querySchema = z.object({
  minX: z.coerce.number().int().min(-1000).max(100_000).optional(),
  maxX: z.coerce.number().int().min(-1000).max(100_000).optional(),
  minY: z.coerce.number().int().min(-1000).max(100_000).optional(),
  maxY: z.coerce.number().int().min(-1000).max(100_000).optional(),
})

export const GET = defineRoute({ query: querySchema }, async ({ request, query }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, {
    refresh: true,
    config: cfg,
    rateLimit: 'standard',
  })

  const view = await getWorldMap(principal.player.id, {
    minX: query.minX,
    maxX: query.maxX,
    minY: query.minY,
    maxY: query.maxY,
  })

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, view, { headers })
})
