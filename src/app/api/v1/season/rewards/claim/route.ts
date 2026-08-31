/**
 * WARLORDS — POST /api/v1/season/rewards/claim (protected).
 *
 * Claims a settled season's reward payout — IDEMPOTENT. The claim row was
 * created by the settlement transaction keyed to the caller (unique
 * seasonId+playerId); the payout is arbitrated by a conditional
 * claimedAt-IS-NULL update and backed by a ledger idempotency key, so
 * replays and concurrent duplicates return the ORIGINAL result (alreadyClaimed)
 * instead of paying twice. The body carries ONLY the seasonId — amounts,
 * rank and tier are server-owned (NEVER TRUST THE CLIENT).
 *
 * Refusals: SEASON_REWARD_NOT_FOUND (404 — nothing waiting / not yours) ·
 * SEASON_NOT_SETTLED (409 — reset has not run) · VALIDATION_ERROR (400).
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requirePlayer, resolveAuthConfig } from '@/lib/auth'
import { claimSeasonReward } from '@/lib/game/services/season.service'

const claimBody = z.object({
  seasonId: z.string().min(1).max(64),
})

export const POST = defineRoute({ body: claimBody }, async ({ request, body }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requirePlayer(request, {
    refresh: true,
    config: cfg,
    rateLimit: 'playerWrite',
  })

  const result = await claimSeasonReward(principal.player.id, body.seasonId)

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, result, { headers })
})
