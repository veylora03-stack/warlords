/**
 * WARLORDS — Session cookie transport (AUTHENTICATION.md §1).
 *
 * Cookie: `wl_session` — HttpOnly + SameSite=Lax + Path=/, `Secure` in
 * production (HTTPS-only). Bearer tokens remain available for native
 * contexts; the Authorization header takes precedence when present.
 */

import { SESSION_COOKIE_NAME } from './session.config'

/** Extracts the session JWT from a raw `Cookie` header, if present. */
export function readSessionCookieToken(request: Request): string | undefined {
  const header = request.headers.get('cookie')
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (name === SESSION_COOKIE_NAME) {
      const value = part.slice(eq + 1).trim()
      return value.length > 0 ? value : undefined
    }
  }
  return undefined
}

/** `Authorization: Bearer <token>` — case-insensitive scheme per RFC 7235. */
export function readBearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization')
  if (!header) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header)
  const token = match?.[1]?.trim()
  return token ? token : undefined
}

export function readSessionToken(request: Request): string | undefined {
  return readBearerToken(request) ?? readSessionCookieToken(request)
}

export function buildSessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeSeconds)}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function buildClearedSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}
