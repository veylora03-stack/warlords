/**
 * WARLORDS — Auth service DTOs (stable public shapes for routes + tests).
 */

export interface AuthUserProfile {
  id: string
  telegramId: string
  username: string | null
  firstName: string
  lastName: string | null
  photoUrl: string | null
  role: string
}

export interface AuthPlayerProfile {
  id: string
  name: string
  level: number
}

export interface AuthSessionInfo {
  id: string
  expiresAt: Date
  lastUsedAt: Date
}

export interface ExchangeResult {
  token: string
  tokenType: 'Bearer'
  expiresAt: Date
  /** True when the SAME initData was exchanged again — no new session row. */
  replayed: boolean
  user: AuthUserProfile
  player: AuthPlayerProfile | null
  session: AuthSessionInfo
}

export interface AuthPrincipal {
  user: AuthUserProfile
  player: AuthPlayerProfile | null
  session: AuthSessionInfo
  /** The bearer token that produced this principal. */
  token: string
}

export interface RefreshedSession {
  token: string
  expiresAt: Date
}

export interface ExchangeInput {
  initData: string
  ip?: string
  userAgent?: string
}
