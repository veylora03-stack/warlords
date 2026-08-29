/**
 * Unit tests — environment config layer (src/config/env).
 * Uses the pure loadEnv() so tests never pollute the cached production env.
 */

import { describe, it, expect } from 'bun:test'
import { loadEnv, ConfigError } from '../../src/config/env'

const BASE_ENV = {
  DATABASE_URL: 'file:./db/test.db',
  NODE_ENV: 'test',
}

describe('loadEnv', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const env = loadEnv(BASE_ENV)
    expect(env.DATABASE_URL).toBe('file:./db/test.db')
    expect(env.LOG_LEVEL).toBe('info')
    expect(env.isTest).toBe(true)
    expect(env.isProd).toBe(false)
    expect(env.ADMIN_TELEGRAM_IDS).toEqual([])
  })

  it('rejects a missing DATABASE_URL with a clear issue', () => {
    expect(() => loadEnv({ NODE_ENV: 'test' })).toThrow(ConfigError)
    try {
      loadEnv({})
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError)
      const cfgErr = err as ConfigError
      expect(cfgErr.issues.some((i) => i.includes('DATABASE_URL'))).toBe(true)
    }
  })

  it('rejects an unknown LOG_LEVEL', () => {
    expect(() => loadEnv({ ...BASE_ENV, LOG_LEVEL: 'verbose' })).toThrow(ConfigError)
  })

  it('enforces JWT_SECRET minimum length when provided', () => {
    expect(() => loadEnv({ ...BASE_ENV, JWT_SECRET: 'short' })).toThrow(ConfigError)
    const env = loadEnv({ ...BASE_ENV, JWT_SECRET: 'x'.repeat(32) })
    expect(env.JWT_SECRET).toHaveLength(32)
  })

  it('parses ADMIN_TELEGRAM_IDS into a number array', () => {
    const env = loadEnv({ ...BASE_ENV, ADMIN_TELEGRAM_IDS: '111, 222' })
    expect(env.ADMIN_TELEGRAM_IDS).toEqual([111, 222])
  })

  it('rejects malformed ADMIN_TELEGRAM_IDS', () => {
    expect(() => loadEnv({ ...BASE_ENV, ADMIN_TELEGRAM_IDS: '111, oops' })).toThrow(ConfigError)
  })

  it('freezes the returned env object', () => {
    const env = loadEnv(BASE_ENV)
    expect(() => {
      ;(env as unknown as Record<string, unknown>)['DATABASE_URL'] = 'tampered'
    }).toThrow()
  })
})
