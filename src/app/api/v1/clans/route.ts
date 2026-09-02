/**
 * WARLORDS — /api/v1/clans (protected).
 *
 * POST — create a clan (caller becomes LEADER). The client supplies a name,
 * a tag and optional description/joinPolicy — NOTHING else: membership,
 * roles and uniqueness are resolved server-side in one transaction.
 *
 * GET — list clans (paginated, largest first).
 *
 * Refusals (typed, zero writes): VALIDATION_ERROR · ALREADY_IN_CLAN ·
 * CLAN_NAME_TAKEN · CLAN_TAG_TAKEN · PLAYER_NOT_FOUND.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { createClan, listClans } from '@/lib/game/services/clan.service'

const bodySchema = z.object({
  name: z.string().min(1).max(64),
  tag: z.string().min(1).max(8),
  description: z.string().max(200).optional(),
  joinPolicy: z.enum(['OPEN', 'INVITE_ONLY']).optional(),
})

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
})

export const POST = defineRoute({ body: bodySchema }, async ({ request, body }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, {
    refresh: true,
    config: cfg,
    rateLimit: 'playerWrite',
  })

  const result = await createClan(principal.player.id, body)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, result, { headers })
})

export const GET = defineRoute({ query: querySchema }, async ({ request, query }) => {
  const cfg = resolveAuthConfig(getEnv())
  await requirePlayer(request, { refresh: false, config: cfg, rateLimit: 'standard' })
  const result = await listClans({ page: query.page, pageSize: query.pageSize })
  return ok(request, result, {
    meta: { page: result.page, total: result.total },
  })
})
