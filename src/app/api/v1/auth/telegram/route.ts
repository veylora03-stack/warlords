/**
 * WARLORDS — POST /api/v1/auth/telegram (AUTHENTICATION.md Flow A).
 *
 * Mini App login: { initData } → HMAC verification against the server-side
 * bot token → transactional user/session/player issuance → HttpOnly session
 * cookie + Bearer token for native contexts.
 *
 * The bot token NEVER appears in any client-visible surface; the raw initData
 * is accepted exactly once and never logged or persisted.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { clientIp, userAgent } from '@/lib/api/request-info'
import { getEnv } from '@/config/env'
import { enforceRateLimit, getSharedRateLimitStore } from '@/lib/rate-limit'
import {
  AUTH_RATE_LIMIT,
  buildSessionCookie,
  exchangeInitData,
  resolveAuthConfig,
} from '@/lib/auth'
import { INIT_DATA_MAX_LENGTH } from '@/lib/telegram'

const bodySchema = z.object({
  initData: z.string().min(1, 'initData is required').max(INIT_DATA_MAX_LENGTH),
})

export const POST = defineRoute({ body: bodySchema }, async ({ request, body }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)

  // Auth group rate limit (API_DESIGN §1.4) — before any crypto or DB work.
  enforceRateLimit(getSharedRateLimitStore(), {
    key: `auth:${clientIp(request)}`,
    limit: AUTH_RATE_LIMIT.limit,
    windowMs: AUTH_RATE_LIMIT.windowMs,
  })

  const result = await exchangeInitData(
    {
      initData: body.initData,
      ip: clientIp(request),
      userAgent: userAgent(request),
    },
    cfg,
  )

  return ok(
    request,
    {
      token: result.token,
      tokenType: result.tokenType,
      expiresAt: result.expiresAt,
      replayed: result.replayed,
      user: result.user,
      player: result.player,
      session: { id: result.session.id, expiresAt: result.session.expiresAt },
    },
    {
      headers: {
        'set-cookie': buildSessionCookie(result.token, cfg.sessionTtlSeconds, env.isProd),
      },
    },
  )
})
