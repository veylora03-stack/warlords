/**
 * WARLORDS — POST /api/v1/auth/logout (protected).
 *
 * Revokes the CURRENT session row (server-side — a stolen token dies with
 * it) and clears the cookie. Idempotent: revoking twice succeeds.
 */

import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import {
  buildClearedSessionCookie,
  requireAuth,
  resolveAuthConfig,
  revokeSession,
} from '@/lib/auth'

export const POST = defineRoute({}, async ({ request }) => {
  const cfg = resolveAuthConfig()
  const { principal } = await requireAuth(request, { config: cfg })
  await revokeSession(principal.session.id, principal.user.id)

  return ok(
    request,
    { loggedOut: true },
    {
      headers: { 'set-cookie': buildClearedSessionCookie() },
    },
  )
})
