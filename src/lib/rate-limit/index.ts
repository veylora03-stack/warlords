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

// ── Principal-keyed groups (Phase 23 hardening) ─────────────────────────────

/**
 * Per-IDENTITY throttles for authenticated surfaces. The auth endpoints stay
 * IP-keyed (pre-login there is no identity); everything past the guard is
 * throttled by the DB-resolved principal — an identity a client cannot
 * forge or rotate. Groups are data-driven so routes declare INTENT
 * (`enforcePrincipalRateLimit(id, 'adminBroadcast')`) instead of raw numbers.
 *
 * The generous default (standard) is a per-user abuse backstop, not a UX
 * constraint; the tight groups exist because these operations are either
 * expensive (broadcast fan-out, settlement) or destructive.
 */
export const RATE_LIMIT_GROUPS = {
  /** Authenticated default — every route via requireAuth (abuse backstop). */
  standard: { limit: 300, windowMs: 60_000 },
  /** Player game mutations (upgrade/finish/train/claim/read...). */
  playerWrite: { limit: 120, windowMs: 60_000 },
  /** Admin panel reads (searches, inspections). */
  adminRead: { limit: 240, windowMs: 60_000 },
  /** Admin panel mutations (ban, adjust, staff, events...). */
  adminWrite: { limit: 60, windowMs: 60_000 },
  /** Whole-population notification fan-out. */
  adminBroadcast: { limit: 5, windowMs: 60_000 },
  /** Season settlement (simulate + execute). */
  adminSettle: { limit: 5, windowMs: 60_000 },
  /** Notification queue drain tick. */
  adminDrain: { limit: 30, windowMs: 60_000 },
} as const

export type RateLimitGroupName = keyof typeof RATE_LIMIT_GROUPS

export function enforcePrincipalRateLimit(
  principalId: string,
  group: RateLimitGroupName,
  nowMs: number = Date.now(),
): RateLimitDecision {
  const g = RATE_LIMIT_GROUPS[group]
  return enforceRateLimit(
    getSharedRateLimitStore(),
    {
      key: `${group}:${principalId}`,
      limit: g.limit,
      windowMs: g.windowMs,
    },
    nowMs,
  )
}
