/**
 * WARLORDS — Auth module public surface.
 * Routes import ONLY from this barrel (module boundary rule).
 */
export {
  SESSION_COOKIE_NAME,
  SESSION_REFRESH_THRESHOLD_SECONDS,
  AUTH_RATE_LIMIT,
  DEV_IMPERSONATE_RATE_LIMIT,
  resolveAuthConfig,
} from './session.config'
export type { AuthConfig } from './session.config'
export { mintSessionToken, verifySessionToken } from './jwt'
export type { SessionClaims, MintedToken } from './jwt'
export {
  readSessionCookieToken,
  readBearerToken,
  readSessionToken,
  buildSessionCookie,
  buildClearedSessionCookie,
} from './cookies'
export { sha256Hex, safeDigestEqual } from './hash'
export {
  exchangeInitData,
  exchangeDevImpersonation,
  assertDevImpersonationAllowed,
  authenticate,
  revokeSession,
} from './session.service'
export type {
  AuthUserProfile,
  AuthPlayerProfile,
  AuthSessionInfo,
  ExchangeResult,
  AuthPrincipal,
  RefreshedSession,
  ExchangeInput,
} from './session.types'
export { requireAuth, requirePlayer, requireAdmin } from './guard'
export type { RequireAuthOptions, RequireAuthResult, RequirePlayerResult } from './guard'
