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
import { AppError } from '@/lib/api/errors'
import { db } from '@/lib/db'
import { enforcePrincipalRateLimit, type RateLimitGroupName } from '@/lib/rate-limit'
import { adminRoleHasScope, adminScopesForRole, type AdminScope } from '@/lib/game/config/admin'
import type { AuthPrincipal, RefreshedSession } from './session.types'

interface ActiveAdminRow {
  id: string
  role: string
}

/** DB-backed active-admin check (admin_users is the revocation surface). */
async function findActiveAdmin(userId: string): Promise<ActiveAdminRow | null> {
  const admin = await db.adminUser.findUnique({
    where: { userId },
    select: { id: true, role: true, isActive: true },
  })
  if (!admin || !admin.isActive) return null
  return { id: admin.id, role: admin.role }
}

export interface RequireAuthOptions {
  /** Re-issue the token when the session is inside the sliding window. */
  refresh?: boolean
  /** Test seam — inject a resolved config instead of reading env. */
  config?: AuthConfig
  /**
   * Per-identity throttle group (Phase 23 hardening). Applied on EVERY
   * authenticated request against the DB-resolved user id — an identity a
   * client cannot forge. Routes may pass a tighter group for expensive or
   * destructive operations; the default is a generous abuse backstop.
   * Pass `null` to opt out (test seams only).
   */
  rateLimit?: RateLimitGroupName | null
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
  const result = await authenticate(request, cfg, { refresh: options.refresh })

  // Per-identity abuse backstop — AFTER authentication (the key is the
  // DB-resolved user id, not any client-supplied value).
  if (options.rateLimit !== null) {
    enforcePrincipalRateLimit(result.principal.user.id, options.rateLimit ?? 'standard')
  }

  return result
}

export interface RequirePlayerResult {
  principal: AuthPrincipal & { player: NonNullable<AuthPrincipal['player']> }
  refreshed?: RefreshedSession
}

/**
 * Auth + player-presence gate for the Player System routes. A session
 * without a bootstrapped player is a server-side inconsistency — surfaced
 * as PLAYER_NOT_FOUND (404), never as a client-fixable state.
 */
export async function requirePlayer(
  request: Request,
  options: RequireAuthOptions = {},
): Promise<RequirePlayerResult> {
  const { principal, refreshed } = await requireAuth(request, options)
  if (!principal.player) {
    throw new AppError('PLAYER_NOT_FOUND', 'Player not found')
  }
  return { principal: principal as RequirePlayerResult['principal'], refreshed }
}

/**
 * Admin gate for operator-only routes. The AdminUser row is the SINGLE
 * source of authorization truth (DB-backed, revocable without touching
 * auth); the requested SCOPE resolves through the RBAC matrix in
 * config/admin.ts. A valid session without an active admin row is 403
 * ADMIN_REQUIRED; an admin whose role lacks the scope is 403
 * ADMIN_FORBIDDEN. No route ever trusts a client-declared role.
 */
export async function requireAdminScope(
  request: Request,
  scope: AdminScope,
  options: RequireAuthOptions = {},
): Promise<RequireAuthResult & { adminUserId: string; adminRole: string }> {
  const { principal, refreshed } = await requireAuth(request, options)
  const admin = await findActiveAdmin(principal.user.id)
  if (!admin) {
    throw new AppError('ADMIN_REQUIRED', 'Administrator privileges required')
  }
  if (!adminRoleHasScope(admin.role, scope)) {
    throw new AppError('ADMIN_FORBIDDEN', `This action requires the ${scope} scope`)
  }
  return { principal, refreshed, adminUserId: principal.user.id, adminRole: admin.role }
}

/**
 * Introspection for the admin panel UI (GET /api/v1/admin/me). Returns
 * isStaff:false for non-staff callers instead of throwing — the panel is a
 * VIEW over the same server-enforced scopes, never the enforcement itself.
 */
export async function resolveAdminContext(
  request: Request,
  options: RequireAuthOptions = {},
): Promise<
  | ({ isStaff: true; adminRole: string; scopes: readonly AdminScope[] } & RequireAuthResult)
  | ({ isStaff: false } & RequireAuthResult)
> {
  const { principal, refreshed } = await requireAuth(request, options)
  const admin = await findActiveAdmin(principal.user.id)
  if (!admin) return { isStaff: false, principal, refreshed }
  return {
    isStaff: true,
    adminRole: admin.role,
    scopes: adminScopesForRole(admin.role),
    principal,
    refreshed,
  }
}
