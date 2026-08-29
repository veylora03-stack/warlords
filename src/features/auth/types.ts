/**
 * WARLORDS — Auth feature: client-facing session projection.
 * Mirrors GET /api/v1/auth/me payloads (dates arrive as ISO strings).
 */

export interface AuthUserData {
  id: string
  telegramId: string
  username: string | null
  firstName: string
  lastName: string | null
  photoUrl: string | null
  role: string
}

export interface AuthPlayerData {
  id: string
  name: string
  level: number
}

export interface AuthSessionData {
  id: string
  expiresAt: string
  lastUsedAt: string
}

export interface MeData {
  user: AuthUserData
  player: AuthPlayerData | null
  session: AuthSessionData
}
