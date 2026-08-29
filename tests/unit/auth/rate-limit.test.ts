/**
 * Unit tests — sliding-window rate limiter (src/lib/rate-limit).
 * Time is injected — no timers, no sleeps.
 */

import { describe, it, expect } from 'bun:test'
import {
  createMemoryRateLimitStore,
  enforceRateLimit,
  getSharedRateLimitStore,
} from '../../../src/lib/rate-limit'
import { AppError } from '../../../src/lib/api/errors'

const WINDOW = 60_000

describe('memory sliding-window store', () => {
  it('allows requests up to the limit, then blocks', () => {
    const store = createMemoryRateLimitStore()
    let now = 1_000_000
    for (let i = 0; i < 3; i++) {
      const d = store.hit('k', now, WINDOW, 3)
      expect(d.allowed).toBe(true)
      now += 100
    }
    const blocked = store.hit('k', now, WINDOW, 3)
    expect(blocked.allowed).toBe(false)
    expect(blocked.count).toBe(4)
    expect(blocked.limit).toBe(3)
  })

  it('frees the budget as the window slides', () => {
    const store = createMemoryRateLimitStore()
    const t0 = 2_000_000
    for (let i = 0; i < 5; i++) store.hit('k', t0 + i, WINDOW, 5)
    // After the first hit leaves the window, one more request fits again.
    const after = store.hit('k', t0 + WINDOW + 1, WINDOW, 5)
    expect(after.allowed).toBe(true)
  })

  it('reports retryAfterSec ≥ 1 based on the oldest hit', () => {
    const store = createMemoryRateLimitStore()
    const t0 = 3_000_000
    for (let i = 0; i < 2; i++) store.hit('k', t0 + i, WINDOW, 1)
    const blocked = store.hit('k', t0 + 10, WINDOW, 1)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1)
    expect(blocked.resetAt).toBe(t0 + WINDOW)
  })

  it('isolates keys from each other', () => {
    const store = createMemoryRateLimitStore()
    const t = 4_000_000
    store.hit('a', t, WINDOW, 1)
    const b = store.hit('b', t, WINDOW, 1)
    expect(b.allowed).toBe(true)
  })

  it('prune drops only expired buckets', () => {
    const store = createMemoryRateLimitStore()
    const t = 5_000_000
    store.hit('old', t, WINDOW, 10)
    store.hit('fresh', t, WINDOW, 10)
    store.prune(t + WINDOW + 1, WINDOW)
    const oldHit = store.hit('old', t + WINDOW + 1, WINDOW, 10)
    expect(oldHit.count).toBe(1) // bucket was pruned, count restarted
  })
})

describe('enforceRateLimit', () => {
  it('returns the decision while allowed', () => {
    const store = createMemoryRateLimitStore()
    const t = 6_000_000
    const d = enforceRateLimit(store, { key: 'auth:1.2.3.4', limit: 10, windowMs: WINDOW }, t)
    expect(d.allowed).toBe(true)
    expect(d.count).toBe(1)
  })

  it('throws RATE_LIMITED (429) with retry details when exceeded', () => {
    const store = createMemoryRateLimitStore()
    const t = 7_000_000
    try {
      for (let i = 0; i < 3; i++) {
        enforceRateLimit(store, { key: 'auth:5.6.7.8', limit: 2, windowMs: WINDOW }, t + i)
      }
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      const appErr = err as AppError
      expect(appErr.code).toBe('RATE_LIMITED')
      expect(appErr.httpStatus).toBe(429)
      expect(appErr.details?.['retryAfterSec']).toBeGreaterThanOrEqual(1)
      expect(appErr.details?.['limit']).toBe(2)
    }
  })
})

describe('shared store', () => {
  it('returns the same process-wide instance', () => {
    expect(getSharedRateLimitStore()).toBe(getSharedRateLimitStore())
  })
})
