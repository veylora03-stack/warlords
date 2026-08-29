/**
 * WARLORDS — GET /api/v1/auth/me (protected).
 *
 * Authorization middleware demo + session introspection: returns the
 * authenticated identity (fresh from DB — role/ban state authoritative),
 * the player projection, and session metadata. Inside the sliding-refresh
 * window the session is re-issued (Set-Cookie + refreshed.token).
 */

import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAuth, resolveAuthConfig } from '@/lib/auth'

export const GET = defineRoute({}, async ({ request }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { principal, refreshed } = await requireAuth(request, { refresh: true, config: cfg })

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }

  return ok(
    request,
    {
      user: principal.user,
      player: principal.player,
      session: {
        id: principal.session.id,
        expiresAt: principal.session.expiresAt,
        lastUsedAt: principal.session.lastUsedAt,
      },
      ...(refreshed
        ? { refreshed: { token: refreshed.token, expiresAt: refreshed.expiresAt } }
        : {}),
    },
    { headers },
  )
})
