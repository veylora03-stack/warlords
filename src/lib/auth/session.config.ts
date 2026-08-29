/**
 * WARLORDS — Auth configuration & route-group rate-limit contracts.
 *
 * `resolveAuthConfig` is the single place auth reads the validated env.
 * Missing secrets → AUTH_NOT_CONFIGURED (503): a server misconfiguration,
 * never a client fault. Production already fails fast at env load.
 */

import { AppError } from '@/lib/api/errors'
import { getEnv, type Env } from '@/config/env'

/** Cookie carrying the session JWT (SECURITY.md §1.2). */
export const SESSION_COOKIE_NAME = 'wl_session'

/** Sliding refresh: sessions within this window of expiry get re-issued. */
export const SESSION_REFRESH_THRESHOLD_SECONDS = 48 * 3600

/** API_DESIGN.md §1.4 — Auth group: 10/min per IP. */
export const AUTH_RATE_LIMIT = { limit: 10, windowMs: 60_000 } as const

/** AUTHENTICATION.md Flow B — dev impersonation: 5/min per IP. */
export const DEV_IMPERSONATE_RATE_LIMIT = { limit: 5, windowMs: 60_000 } as const

export interface AuthConfig {
  jwtSecret: string
  sessionTtlSeconds: number
  initDataMaxAgeSeconds: number
  botToken: string
}

export function resolveAuthConfig(env: Env = getEnv()): AuthConfig {
  if (!env.JWT_SECRET || !env.TELEGRAM_BOT_TOKEN) {
    throw new AppError(
      'AUTH_NOT_CONFIGURED',
      'Authentication is not configured on this server (JWT_SECRET / TELEGRAM_BOT_TOKEN missing)',
    )
  }
  return {
    jwtSecret: env.JWT_SECRET,
    sessionTtlSeconds: env.SESSION_TTL_SECONDS,
    initDataMaxAgeSeconds: env.TELEGRAM_AUTH_MAX_AGE_SECONDS,
    botToken: env.TELEGRAM_BOT_TOKEN,
  }
}
