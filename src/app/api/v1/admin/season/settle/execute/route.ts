/**
 * WARLORDS — POST /api/v1/admin/season/settle/execute (ADMIN ONLY).
 *
 * The REAL transactional season reset. Safety rails, in order:
 *   1. ADMIN gate (SUPERADMIN role + active admin_users row) — 403 otherwise
 *   2. body { seasonNumber } must MATCH the current season — a stale or
 *      wrong number is a typed 409 (belt-and-braces against races)
 *   3. inside ONE transaction: at-most-once settledAt claim → final ranking
 *      → reward claims → permanent grants → seasonal wipe → next season →
 *      audit row (SEASON_SETTLE with the report summary)
 * Concurrent executors converge on exactly one winner; the losers roll back
 * with SEASON_ALREADY_SETTLED.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { AppError } from '@/lib/api/errors'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { settleSeason } from '@/lib/game/services/season-settlement.service'
import { db } from '@/lib/db'

const executeBody = z.object({
  seasonNumber: z.number().int().min(1),
})

export const POST = defineRoute({ body: executeBody }, async ({ request, body }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requireAdminScope(request, 'season.settle', {
    refresh: true,
    config: cfg,
  })

  // Belt-and-braces: the operator must confirm WHICH season is being reset.
  const latest = await db.season.findFirst({ orderBy: { number: 'desc' } })
  if (!latest || latest.number !== body.seasonNumber) {
    throw new AppError('SETTLEMENT_NOT_PENDING', 'seasonNumber does not match the current season', {
      expected: latest?.number ?? null,
      received: body.seasonNumber,
    })
  }

  const report = await settleSeason(principal.user.id)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, report, { headers })
})
