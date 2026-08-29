/**
 * WARLORDS — Route-level authorization middleware.
 *
 * WHY NOT next.ts `middleware.ts`: the edge middleware runtime cannot run
 * Prisma, and the ban/role check MUST hit the database (SECURITY.md — ban
 * enforcement on every request). So the guard composes into every protected
 * route via `defineRoute`:
 *
 *   export const GET = defineRoute({}, async ({ request }) => {
 *     const { principal, refreshed } = await requireAuth(request, { refresh: true })
 *     ...
 *   })
 *
 * Failures throw typed AppErrors → uniform 401/403 envelopes.
 */

import { authenticate } from './session.service'
import { resolveAuthConfig, type AuthConfig } from './session.config'
import type { AuthPrincipal, RefreshedSession } from './session.types'

export interface RequireAuthOptions {
  /** Re-issue the token when the session is inside the sliding window. */
  refresh?: boolean
  /** Test seam — inject a resolved config instead of reading env. */
  config?: AuthConfig
}

export interface RequireAuthResult {
  principal: AuthPrincipal
  refreshed?: RefreshedSession
}

export async function requireAuth(
  request: Request,
  options: RequireAuthOptions = {},
): Promise<RequireAuthResult> {
  const cfg = options.config ?? resolveAuthConfig()
  return authenticate(request, cfg, { refresh: options.refresh })
}
