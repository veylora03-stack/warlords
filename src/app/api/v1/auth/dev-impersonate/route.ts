/**
 * WARLORDS — POST /api/v1/auth/dev-impersonate (AUTHENTICATION.md Flow B).
 *
 * NON-PRODUCTION ONLY dev login for exercising the Mini App in a plain
 * browser. Guards, in order: rate limit (5/min per IP) → NODE_ENV gate
 * (404 in production) → ADMIN_SECRET constant-time check → Telegram-id
 * allowlist → audited session issue. Everything is logged as a warning.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { clientIp, userAgent } from '@/lib/api/request-info'
import { getEnv } from '@/config/env'
import { enforceRateLimit, getSharedRateLimitStore } from '@/lib/rate-limit'
import {
  DEV_IMPERSONATE_RATE_LIMIT,
  buildSessionCookie,
  exchangeDevImpersonation,
  assertDevImpersonationAllowed,
  resolveAuthConfig,
} from '@/lib/auth'

const bodySchema = z.object({
  telegramId: z.string().regex(/^\d{1,19}$/, 'telegramId must be an integer string'),
  secret: z.string().min(1).max(256),
  reason: z.string().min(1).max(256).optional(),
})

export const POST = defineRoute({ body: bodySchema }, async ({ request, body }) => {
  const env = getEnv()

  // Brute-force budget BEFORE any secret comparison.
  enforceRateLimit(getSharedRateLimitStore(), {
    key: `dev-impersonate:${clientIp(request)}`,
    limit: DEV_IMPERSONATE_RATE_LIMIT.limit,
    windowMs: DEV_IMPERSONATE_RATE_LIMIT.windowMs,
  })

  assertDevImpersonationAllowed(body.telegramId, body.secret, env)

  const cfg = resolveAuthConfig(env)
  const result = await exchangeDevImpersonation(
    {
      telegramId: body.telegramId,
      ip: clientIp(request),
      userAgent: userAgent(request),
      reason: body.reason,
    },
    cfg,
  )

  return ok(
    request,
    {
      token: result.token,
      tokenType: result.tokenType,
      expiresAt: result.expiresAt,
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
