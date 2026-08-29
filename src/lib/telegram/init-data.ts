/**
 * WARLORDS — Telegram Mini App `initData` verification (pure crypto core).
 *
 * Implements Telegram's official algorithm (core.telegram.org/api/webapps
 * §validating-data-received-via-the-mini-app) with ZERO custom crypto:
 *
 *   1. initData arrives as a URL-encoded query string.
 *   2. data_check_string = every field except `hash`, sorted alphabetically,
 *      joined as `key=value` lines with `\n`.
 *   3. secret_key       = HMAC_SHA256(key="WebAppData", message=BOT_TOKEN)
 *   4. expected_hash    = HMAC_SHA256(key=secret_key, message=data_check_string)
 *   5. constant-time compare against the received `hash`.
 *   6. `auth_date` freshness bounds the replay window (configurable via env).
 *   7. `user` JSON is extracted and shape-validated AFTER the signature check.
 *
 * NEVER TRUST THE CLIENT: nothing from the payload is used before step 5
 * succeeds, the bot token never leaves the server, and the raw initData is
 * never logged (the logger redacts that key as defense in depth).
 *
 * This module is pure: no env, no DB, no HTTP. `now` is injectable for tests.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { AppError } from '@/lib/api/errors'

// ── Validation bounds (Telegram field limits; attacker-controlled input) ────

/** initData is a query string; 8 KiB is far above any legitimate payload. */
export const INIT_DATA_MAX_LENGTH = 8192
/** Clock skew tolerated for `auth_date` set slightly in the future. */
export const AUTH_DATE_MAX_CLOCK_SKEW_SECONDS = 300

const USER_ID_MAX = 2 ** 53 - 1 // JS safe integer — Telegram ids fit comfortably
const NAME_MAX_LENGTH = 64
const USERNAME_MAX_LENGTH = 32
const LANGUAGE_CODE_MAX_LENGTH = 35
const PHOTO_URL_MAX_LENGTH = 1024

// ── Types ────────────────────────────────────────────────────────────────────

/** Canonical identity fields extracted from the signed `user` JSON. */
export interface TelegramInitDataUser {
  id: number
  firstName: string
  lastName?: string
  username?: string
  languageCode?: string
  photoUrl?: string
  isPremium?: boolean
  allowsWriteToPm?: boolean
  addedToAttachmentMenu?: boolean
}

export interface VerifiedInitData {
  user: TelegramInitDataUser
  authDate: Date
  /** The received hex hash (kept for audit correlation only). */
  receivedHash: string
}

/** Machine-readable failure taxonomy — travels as `details.reason`. */
export type InitDataFailureReason =
  | 'empty'
  | 'too_long'
  | 'missing_hash'
  | 'missing_auth_date'
  | 'invalid_auth_date'
  | 'invalid_hash'
  | 'auth_date_in_future'
  | 'expired'
  | 'missing_user'
  | 'invalid_user'

/**
 * Public error surface: ONE code (`INVALID_INIT_DATA`, 401) so the client
 * learns "your initData is bad, refresh it" — the `reason` detail exists for
 * server logs and tests, never for attacker guidance.
 */
export class InitDataError extends AppError {
  readonly reason: InitDataFailureReason

  constructor(reason: InitDataFailureReason, message: string) {
    super('INVALID_INIT_DATA', message, { reason })
    this.name = 'InitDataError'
    this.reason = reason
  }
}

export interface VerifyInitDataOptions {
  botToken: string
  /** Max acceptable age of `auth_date` (seconds). */
  maxAgeSeconds: number
  now?: Date
}

// ── Building blocks (exported for unit tests) ────────────────────────────────

/** Telegram-official key derivation: HMAC("WebAppData", bot token). */
export function deriveSecretKey(botToken: string): Buffer {
  return createHmac('sha256', 'WebAppData').update(botToken).digest()
}

/** Sorted `key=value` lines of every field except `hash`, `\n`-joined. */
export function buildDataCheckString(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}

/** Constant-time hex comparison; unequal lengths/invalid hex → false. */
export function safeHexEqual(expected: Buffer, receivedHex: string): boolean {
  let received: Buffer
  try {
    received = Buffer.from(receivedHex, 'hex')
  } catch {
    return false
  }
  if (received.length !== expected.length) return false
  return timingSafeEqual(expected, received)
}

// ── User extraction ──────────────────────────────────────────────────────────

function parseUser(raw: string | null): TelegramInitDataUser {
  if (raw === null || raw.trim() === '') {
    throw new InitDataError('missing_user', 'initData is missing the user field')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw new InitDataError('invalid_user', 'user field is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InitDataError('invalid_user', 'user field must be a JSON object')
  }
  const obj = parsed as Record<string, unknown>

  const id = obj['id']
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || id > USER_ID_MAX) {
    throw new InitDataError('invalid_user', 'user.id must be a positive safe integer')
  }

  const firstName = obj['first_name']
  if (
    typeof firstName !== 'string' ||
    firstName.trim().length === 0 ||
    firstName.length > NAME_MAX_LENGTH
  ) {
    throw new InitDataError('invalid_user', `user.first_name must be 1..${NAME_MAX_LENGTH} chars`)
  }

  const user: TelegramInitDataUser = { id, firstName }

  const str = (key: string, max: number): string | undefined => {
    const value = obj[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value.length > max) {
      throw new InitDataError('invalid_user', `user.${key} must be a string ≤ ${max} chars`)
    }
    return value
  }
  const bool = (key: string): boolean | undefined => {
    const value = obj[key]
    if (value === undefined) return undefined
    if (typeof value !== 'boolean') {
      throw new InitDataError('invalid_user', `user.${key} must be a boolean`)
    }
    return value
  }

  const lastName = str('last_name', NAME_MAX_LENGTH)
  if (lastName !== undefined) user.lastName = lastName
  const username = str('username', USERNAME_MAX_LENGTH)
  if (username !== undefined) user.username = username
  const languageCode = str('language_code', LANGUAGE_CODE_MAX_LENGTH)
  if (languageCode !== undefined) user.languageCode = languageCode
  const photoUrl = str('photo_url', PHOTO_URL_MAX_LENGTH)
  if (photoUrl !== undefined) {
    if (!photoUrl.startsWith('https://')) {
      throw new InitDataError('invalid_user', 'user.photo_url must be an https URL')
    }
    user.photoUrl = photoUrl
  }
  const isPremium = bool('is_premium')
  if (isPremium !== undefined) user.isPremium = isPremium
  const allowsWriteToPm = bool('allows_write_to_pm')
  if (allowsWriteToPm !== undefined) user.allowsWriteToPm = allowsWriteToPm
  const addedToAttachmentMenu = bool('added_to_attachment_menu')
  if (addedToAttachmentMenu !== undefined) user.addedToAttachmentMenu = addedToAttachmentMenu

  return user
}

// ── Full verification ────────────────────────────────────────────────────────

/**
 * Verifies signature, freshness and user shape. Throws `InitDataError`
 * (INVALID_INIT_DATA / 401) on ANY failure; returns the extracted identity.
 */
export function verifyInitData(initData: string, options: VerifyInitDataOptions): VerifiedInitData {
  if (initData.length === 0) {
    throw new InitDataError('empty', 'initData is empty')
  }
  if (initData.length > INIT_DATA_MAX_LENGTH) {
    throw new InitDataError('too_long', 'initData exceeds the maximum allowed length')
  }

  const params = new URLSearchParams(initData)

  const receivedHash = params.get('hash')
  if (receivedHash === null || receivedHash === '') {
    throw new InitDataError('missing_hash', 'initData is missing the hash field')
  }

  const authDateRaw = params.get('auth_date')
  if (authDateRaw === null || authDateRaw === '') {
    throw new InitDataError('missing_auth_date', 'initData is missing the auth_date field')
  }
  const authDateSeconds = Number(authDateRaw)
  if (!Number.isSafeInteger(authDateSeconds) || authDateSeconds <= 0) {
    throw new InitDataError(
      'invalid_auth_date',
      'auth_date must be a positive integer (unix seconds)',
    )
  }

  // Signature FIRST — everything else in the payload is attacker-controlled
  // until Telegram's HMAC vouches for it.
  const secretKey = deriveSecretKey(options.botToken)
  const expectedHash = createHmac('sha256', secretKey).update(buildDataCheckString(params)).digest()
  if (!safeHexEqual(expectedHash, receivedHash)) {
    throw new InitDataError('invalid_hash', 'initData hash verification failed')
  }

  const now = options.now ?? new Date()
  const nowSeconds = Math.floor(now.getTime() / 1000)
  const ageSeconds = nowSeconds - authDateSeconds

  if (ageSeconds < -AUTH_DATE_MAX_CLOCK_SKEW_SECONDS) {
    throw new InitDataError('auth_date_in_future', 'auth_date is too far in the future')
  }
  if (ageSeconds > options.maxAgeSeconds) {
    throw new InitDataError('expired', 'initData is older than the allowed max age')
  }

  // Signed payload → safe to parse the user object now.
  const user = parseUser(params.get('user'))

  return { user, authDate: new Date(authDateSeconds * 1000), receivedHash }
}
