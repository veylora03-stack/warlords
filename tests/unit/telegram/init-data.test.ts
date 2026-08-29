/**
 * Unit tests — Telegram initData verification (src/lib/telegram).
 *
 * The signer below implements Telegram's OFFICIAL algorithm to CONSTRUCT
 * real test vectors (this is how a genuine Mini App payload is built —
 * there is no mocking: every assertion exercises the actual HMAC path).
 */

import { describe, it, expect } from 'bun:test'
import { createHmac } from 'node:crypto'
import {
  verifyInitData,
  deriveSecretKey,
  buildDataCheckString,
  safeHexEqual,
  InitDataError,
  INIT_DATA_MAX_LENGTH,
  type TelegramInitDataUser,
} from '../../../src/lib/telegram'

const BOT_TOKEN = '700100200:AAUnitTestFixtureToken-not-a-real-secret'
const NOW = new Date('2025-06-01T12:00:00.000Z')

/** Builds a properly signed initData exactly the way Telegram does. */
function signInitData(fields: Record<string, string>, botToken = BOT_TOKEN): string {
  const checkString = buildDataCheckString(new URLSearchParams(fields))
  const expected = createHmac('sha256', deriveSecretKey(botToken)).update(checkString).digest('hex')
  return new URLSearchParams({ ...fields, hash: expected }).toString()
}

function signedPayload(
  overrides: Partial<Record<string, string>> = {},
  botToken = BOT_TOKEN,
): string {
  const user: TelegramInitDataUser = {
    id: 777000123,
    firstName: 'Aryobarzan',
    lastName: 'Of Persis',
    username: 'aryo_wl',
    languageCode: 'fa',
    isPremium: true,
  }
  const fields: Record<string, string> = {
    query_id: 'AAF9tE0aAAAAAF9tE0aQ_wTest',
    auth_date: String(Math.floor(NOW.getTime() / 1000) - 60),
    user: JSON.stringify({
      id: user.id,
      first_name: user.firstName,
      last_name: user.lastName,
      username: user.username,
      language_code: user.languageCode,
      is_premium: user.isPremium,
    }),
    ...overrides,
  }
  if (fields['user'] === null) delete fields['user']
  return signInitData(fields, botToken)
}

function verify(initData: string, maxAgeSeconds = 86_400, botToken = BOT_TOKEN) {
  return verifyInitData(initData, { botToken, maxAgeSeconds, now: NOW })
}

function reasonOf(err: unknown): string {
  return (err as InitDataError).details?.['reason'] as string
}

describe('verifyInitData — valid authentication', () => {
  it('accepts a correctly signed payload and extracts the identity', () => {
    const result = verify(signedPayload())
    expect(result.user.id).toBe(777_000_123)
    expect(result.user.firstName).toBe('Aryobarzan')
    expect(result.user.lastName).toBe('Of Persis')
    expect(result.user.username).toBe('aryo_wl')
    expect(result.user.languageCode).toBe('fa')
    expect(result.user.isPremium).toBe(true)
    expect(result.authDate.toISOString()).toBe(
      new Date(Math.floor(NOW.getTime() / 1000) * 1000 - 60_000).toISOString(),
    )
  })

  it('accepts unknown extra fields (forward compatibility) when signed', () => {
    const result = verify(signedPayload({ chat_instance: '-100200300', chat_type: 'private' }))
    expect(result.user.id).toBe(777_000_123)
  })

  it('accepts auth_date within the clock-skew tolerance', () => {
    const future = Math.floor(NOW.getTime() / 1000) + 120
    const result = verify(signedPayload({ auth_date: String(future) }))
    expect(result.user.id).toBe(777_000_123)
  })

  it('maps optional user fields only when present', () => {
    const minimal = verify(
      signInitData({
        auth_date: String(Math.floor(NOW.getTime() / 1000)),
        user: JSON.stringify({ id: 42, first_name: 'Xerxes' }),
      }),
    )
    expect(minimal.user.username).toBeUndefined()
    expect(minimal.user.photoUrl).toBeUndefined()
    expect(minimal.user.isPremium).toBeUndefined()
  })
})

describe('verifyInitData — signature failures (scenarios 2 & 5)', () => {
  it('rejects a tampered hash', () => {
    const payload = signedPayload()
    const tampered = payload.replace(/hash=.{4}/, 'hash=beef')
    try {
      verify(tampered)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(InitDataError)
      expect((err as InitDataError).code).toBe('INVALID_INIT_DATA')
      expect(reasonOf(err)).toBe('invalid_hash')
    }
  })

  it('rejects manipulated user data (re-signed nothing)', () => {
    // Attacker flips the user JSON after signing → hash no longer covers it.
    const payload = signedPayload()
    const params = new URLSearchParams(payload)
    const evilUser = JSON.stringify({
      id: 1,
      first_name: 'Victim',
      username: 'victim',
    })
    params.set('user', evilUser)
    try {
      verify(params.toString())
      expect.unreachable()
    } catch (err) {
      expect(reasonOf(err)).toBe('invalid_hash')
    }
  })

  it('rejects data signed with a different bot token', () => {
    try {
      verify(signedPayload({}, '111000222:OtherBotTokenEntropyGoesHereOk'))
      expect.unreachable()
    } catch (err) {
      expect(reasonOf(err)).toBe('invalid_hash')
    }
  })

  it('rejects a truncated/garbage hash without leaking comparison details', () => {
    const params = new URLSearchParams(signedPayload())
    params.set('hash', 'zz')
    try {
      verify(params.toString())
      expect.unreachable()
    } catch (err) {
      expect(reasonOf(err)).toBe('invalid_hash')
    }
  })
})

describe('verifyInitData — expiration (scenario 3)', () => {
  it('rejects auth_date older than the max age', () => {
    const stale = Math.floor(NOW.getTime() / 1000) - 86_400 - 10
    try {
      verify(signedPayload({ auth_date: String(stale) }), 86_400)
      expect.unreachable()
    } catch (err) {
      expect(reasonOf(err)).toBe('expired')
    }
  })

  it('accepts auth_date exactly at the boundary', () => {
    const boundary = Math.floor(NOW.getTime() / 1000) - 3_600
    expect(verify(signedPayload({ auth_date: String(boundary) }), 3_600).user.id).toBe(777_000_123)
  })

  it('rejects auth_date too far in the future', () => {
    const farFuture = Math.floor(NOW.getTime() / 1000) + 3600
    try {
      verify(signedPayload({ auth_date: String(farFuture) }))
      expect.unreachable()
    } catch (err) {
      expect(reasonOf(err)).toBe('auth_date_in_future')
    }
  })
})

describe('verifyInitData — malformed payloads (scenario 4 surface)', () => {
  it('rejects empty initData', () => {
    expect(() => verify('')).toThrow(InitDataError)
    try {
      verify('')
      expect.unreachable()
    } catch (err) {
      expect(reasonOf(err)).toBe('empty')
    }
  })

  it('rejects oversized initData', () => {
    expect(() => verify('a='.repeat(INIT_DATA_MAX_LENGTH / 2 + 10))).toThrow(InitDataError)
  })

  it('rejects missing hash', () => {
    const payload = signedPayload().replace(/&?hash=[^&]*/, '')
    expect(reasonOf(capture(() => verify(payload)))).toBe('missing_hash')
  })

  it('rejects missing auth_date', () => {
    const params = new URLSearchParams(signedPayload())
    params.delete('auth_date')
    try {
      verify(params.toString())
      expect.unreachable()
    } catch (err) {
      expect(reasonOf(err)).toBe('missing_auth_date')
    }
  })

  it('rejects non-numeric auth_date', () => {
    const params = new URLSearchParams(signedPayload())
    params.set('auth_date', 'yesterday')
    try {
      verify(params.toString())
      expect.unreachable()
    } catch (err) {
      expect(reasonOf(err)).toBe('invalid_auth_date')
    }
  })
})

describe('verifyInitData — user field validation', () => {
  it('rejects a missing user field', () => {
    // Signed WITHOUT a user field from the start → hash valid, user absent.
    const payload = signInitData({
      query_id: 'AAF9tE0aAAAAAF9tE0aQ_wTest',
      auth_date: String(Math.floor(NOW.getTime() / 1000)),
    })
    expect(reasonOf(capture(() => verify(payload)))).toBe('missing_user')
  })

  it('rejects user that is not JSON', () => {
    const params = new URLSearchParams(signedPayload({ user: 'not-json' }))
    expect(reasonOf(capture(() => verify(params.toString())))).toBe('invalid_user')
  })

  it('rejects invalid user ids (zero / negative / float)', () => {
    for (const id of [0, -5, 1.5]) {
      const params = new URLSearchParams(
        signedPayload({ user: JSON.stringify({ id, first_name: 'A' }) }),
      )
      expect(reasonOf(capture(() => verify(params.toString())))).toBe('invalid_user')
    }
  })

  it('rejects missing or empty first_name', () => {
    for (const user of [{ id: 5 }, { id: 5, first_name: '' }]) {
      const params = new URLSearchParams(signedPayload({ user: JSON.stringify(user) }))
      expect(reasonOf(capture(() => verify(params.toString())))).toBe('invalid_user')
    }
  })

  it('rejects non-https photo_url and non-boolean is_premium', () => {
    const http = new URLSearchParams(
      signedPayload({ user: JSON.stringify({ id: 5, first_name: 'A', photo_url: 'http://x' }) }),
    )
    expect(reasonOf(capture(() => verify(http.toString())))).toBe('invalid_user')
    const premium = new URLSearchParams(
      signedPayload({ user: JSON.stringify({ id: 5, first_name: 'A', is_premium: 'yes' }) }),
    )
    expect(reasonOf(capture(() => verify(premium.toString())))).toBe('invalid_user')
  })
})

describe('crypto helpers', () => {
  it('deriveSecretKey matches the official HMAC("WebAppData", token) derivation', () => {
    const expected = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
    expect(deriveSecretKey(BOT_TOKEN).equals(expected)).toBe(true)
  })

  it('safeHexEqual is false for different lengths and different digests', () => {
    const a = Buffer.from('aabbccdd', 'hex')
    expect(safeHexEqual(a, 'aabbcc')).toBe(false)
    expect(safeHexEqual(a, 'aabbccde')).toBe(false)
    expect(safeHexEqual(a, 'AABBCCDD')).toBe(true) // case-insensitive hex parse
  })
})

// ── helpers ──────────────────────────────────────────────────────────────────

function capture(fn: () => unknown): unknown {
  try {
    fn()
  } catch (err) {
    return err
  }
  throw new Error('expected fn to throw')
}
