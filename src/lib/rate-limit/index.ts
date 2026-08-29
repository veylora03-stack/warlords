/**
 * WARLORDS — In-memory sliding-window rate limiter.
 *
 * SECURITY.md §2.2: per user/IP + route-group limits with a Redis-ready
 * interface. The store here is the single-process MVP implementation
 * (documented limitation: multi-instance deployments back it with Redis —
 * swap `RateLimitStore`, keep `enforceRateLimit` unchanged).
 *
 * Sliding window: a request is allowed while fewer than `limit` hits exist
 * inside the trailing `windowMs`. Timestamps are caller-injectable for tests.
 */

import { AppError } from '@/lib/api/errors'

export interface RateLimitDecision {
  allowed: boolean
  /** Hits inside the current window INCLUDING this request. */
  count: number
  limit: number
  /** Epoch ms when the oldest hit leaves the window (retry horizon). */
  resetAt: number
  retryAfterSec: number
}

export interface RateLimitStore {
  /** Records one hit and returns the sliding-window decision. */
  hit(key: string, nowMs: number, windowMs: number, limit: number): RateLimitDecision
  /** Drops all timestamps older than the window (housekeeping). */
  prune(nowMs: number, windowMs: number): void
}

export function createMemoryRateLimitStore(): RateLimitStore {
  const buckets = new Map<string, { hits: number[] }>()

  return {
    hit(key, nowMs, windowMs, limit) {
      const windowStart = nowMs - windowMs
      const bucket = buckets.get(key) ?? { hits: [] }
      bucket.hits = bucket.hits.filter((t) => t > windowStart)
      bucket.hits.push(nowMs)
      buckets.set(key, bucket)

      const count = bucket.hits.length
      const resetAt = count > 0 ? bucket.hits[0]! + windowMs : nowMs + windowMs
      return {
        allowed: count <= limit,
        count,
        limit,
        resetAt,
        retryAfterSec: Math.max(1, Math.ceil((resetAt - nowMs) / 1000)),
      }
    },

    prune(nowMs, windowMs) {
      const windowStart = nowMs - windowMs
      for (const [key, bucket] of buckets) {
        bucket.hits = bucket.hits.filter((t) => t > windowStart)
        if (bucket.hits.length === 0) buckets.delete(key)
      }
    },
  }
}

// ── Shared store (one limiter per server process) ────────────────────────────

const globalForRateLimit = globalThis as unknown as {
  __warlordsRateLimitStore: RateLimitStore | undefined
}

/** Process-wide store so every route group shares one budget per key. */
export function getSharedRateLimitStore(): RateLimitStore {
  globalForRateLimit.__warlordsRateLimitStore ??= createMemoryRateLimitStore()
  return globalForRateLimit.__warlordsRateLimitStore
}

export interface RateLimitRule {
  /** Namespaced key, e.g. `auth:1.2.3.4`. */
  key: string
  limit: number
  windowMs: number
}

/**
 * Records a hit and throws `RATE_LIMITED` (429) when the rule is exceeded.
 * `details` carry retryAfterSec/limit for the client + API contract tests.
 */
export function enforceRateLimit(
  store: RateLimitStore,
  rule: RateLimitRule,
  nowMs: number = Date.now(),
): RateLimitDecision {
  const decision = store.hit(rule.key, nowMs, rule.windowMs, rule.limit)
  if (!decision.allowed) {
    throw new AppError('RATE_LIMITED', 'Too many requests — slow down', {
      retryAfterSec: decision.retryAfterSec,
      limit: decision.limit,
      windowSec: Math.round(rule.windowMs / 1000),
    })
  }
  return decision
}
