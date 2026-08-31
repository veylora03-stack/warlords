/**
 * WARLORDS — GET /api/v1/admin/me.
 *
 * Admin-panel introspection for the signed-in caller: is this session
 * staff, which role, and which SCOPES the RBAC matrix grants. This powers
 * UI visibility ONLY — every endpoint still enforces its own scope
 * server-side (a hidden button protects nothing; this endpoint never
 * pretends to).
 */

import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, resolveAdminContext, resolveAuthConfig } from '@/lib/auth'

export const GET = defineRoute({}, async ({ request }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const context = await resolveAdminContext(request, { refresh: true, config: cfg })

  const headers: Record<string, string> = {}
  if (context.refreshed) {
    headers['set-cookie'] = buildSessionCookie(
      context.refreshed.token,
      cfg.sessionTtlSeconds,
      env.isProd,
    )
  }
  return ok(request, context, { headers })
})
