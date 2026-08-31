/**
 * WARLORDS — POST /api/v1/season/progression/title (protected).
 *
 * Equips an OWNED title, or clears the equipped title with { titleId: null }.
 * Ownership is verified against the real player_titles row — a client can
 * only select among the titles it actually holds (TITLE_NOT_OWNED 409).
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { equipTitle } from '@/lib/game/services/season.service'

const equipBody = z.object({
  titleId: z.string().min(1).max(64).nullable(),
})

export const POST = defineRoute({ body: equipBody }, async ({ request, body }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, { refresh: true, config: cfg })

  const result = await equipTitle(principal.player.id, body.titleId)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, result, { headers })
})
