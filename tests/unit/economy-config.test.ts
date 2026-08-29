/**
 * Unit tests — Economy config & pure math (Phase 5).
 *
 * The config layer is the ONLY place economy numbers live, so its internal
 * consistency is a contract: every resource has a cap, caps sit below the
 * mutation ceiling, and the reason catalog contains the canonical economy
 * reasons. Pure helpers are exhaustively boundary-tested here so the
 * service-level integration tests can focus on DB behavior.
 */

import { describe, it, expect } from 'bun:test'
import {
  ECONOMY_RESOURCES,
  LEDGER_REASONS,
  MAX_DELTA,
  RESOURCE_CAPS,
  creditWithCap,
  debitBalance,
  isEconomyDelta,
  isPositiveAmount,
} from '../../src/lib/game/config/economy'
import { RESOURCES } from '../../src/lib/game/types/common'
import { activeLockKeys, withKeyLock } from '../../src/lib/concurrency/mutex'

describe('economy config invariants', () => {
  it('exposes exactly the six canonical resources in canonical order', () => {
    expect([...ECONOMY_RESOURCES]).toEqual(['GOLD', 'WOOD', 'IRON', 'FOOD', 'CRYSTAL', 'GEMS'])
  })

  it('extends the wallet RESOURCES with the premium GEMS currency', () => {
    for (const walletResource of RESOURCES) {
      expect(ECONOMY_RESOURCES.includes(walletResource)).toBeTrue()
    }
    expect(ECONOMY_RESOURCES.includes('GEMS')).toBeTrue()
  })

  it('has a positive cap for every resource, all below the mutation ceiling', () => {
    for (const resource of ECONOMY_RESOURCES) {
      const cap = RESOURCE_CAPS[resource]
      expect(cap > 0n).toBeTrue()
      expect(cap <= MAX_DELTA).toBeTrue()
    }
  })

  it('caps GEMS tighter than the base resources (premium discipline)', () => {
    expect(RESOURCE_CAPS['GEMS']).toBeLessThan(RESOURCE_CAPS['GOLD'])
  })

  it('contains the canonical economy reasons in the ledger catalog', () => {
    for (const reason of [
      'BOOTSTRAP',
      'QUEST_REWARD',
      'BUILDING_UPGRADE',
      'UNIT_TRAINING',
      'BATTLE_REWARD',
      'MARKET_PURCHASE',
      'MARKET_SALE',
      'ADMIN_ADJUSTMENT',
    ]) {
      expect(LEDGER_REASONS.includes(reason as (typeof LEDGER_REASONS)[number])).toBeTrue()
    }
  })

  it('has no duplicate ledger reasons', () => {
    expect(new Set(LEDGER_REASONS).size).toBe(LEDGER_REASONS.length)
  })
})

describe('creditWithCap (overflow-safe credit)', () => {
  it('applies a normal credit unchanged', () => {
    const result = creditWithCap(1000n, 300n, 5000n)
    expect(result.balanceAfter).toBe(1300n)
    expect(result.applied).toBe(300n)
    expect(result.capped).toBeFalse()
  })

  it('clamps exactly at the cap when the credit overshoots', () => {
    const result = creditWithCap(4800n, 3000n, 5000n)
    expect(result.balanceAfter).toBe(5000n)
    expect(result.applied).toBe(200n)
    expect(result.capped).toBeTrue()
  })

  it('applies zero when already at the cap (never exceeds it)', () => {
    const result = creditWithCap(5000n, 3000n, 5000n)
    expect(result.balanceAfter).toBe(5000n)
    expect(result.applied).toBe(0n)
    expect(result.capped).toBeTrue()
  })

  it('never produces a balance above the cap even from huge credits', () => {
    const result = creditWithCap(0n, MAX_DELTA, 1_000_000n)
    expect(result.balanceAfter).toBe(1_000_000n)
    expect(result.balanceAfter <= 1_000_000n).toBeTrue()
  })
})

describe('debitBalance (no-negative guard)', () => {
  it('applies a normal debit', () => {
    const result = debitBalance(1000n, 400n)
    expect(result.ok).toBeTrue()
    if (result.ok) expect(result.balanceAfter).toBe(600n)
  })

  it('allows debiting the exact balance down to zero (never below)', () => {
    const result = debitBalance(1000n, 1000n)
    expect(result.ok).toBeTrue()
    if (result.ok) expect(result.balanceAfter).toBe(0n)
  })

  it('refuses a debit larger than the balance', () => {
    const result = debitBalance(1000n, 1001n)
    expect(result.ok).toBeFalse()
    if (!result.ok) expect(result.balanceAfter).toBe(1000n)
  })
})

describe('delta & amount predicates', () => {
  it('accepts valid signed deltas within the ceiling', () => {
    expect(isEconomyDelta(1n)).toBeTrue()
    expect(isEconomyDelta(-1n)).toBeTrue()
    expect(isEconomyDelta(MAX_DELTA)).toBeTrue()
    expect(isEconomyDelta(-MAX_DELTA)).toBeTrue()
  })

  it('rejects zero and out-of-bound deltas', () => {
    expect(isEconomyDelta(0n)).toBeFalse()
    expect(isEconomyDelta(MAX_DELTA + 1n)).toBeFalse()
    expect(isEconomyDelta(-(MAX_DELTA + 1n))).toBeFalse()
  })

  it('positive-amount predicate matches the same ceiling', () => {
    expect(isPositiveAmount(1n)).toBeTrue()
    expect(isPositiveAmount(MAX_DELTA)).toBeTrue()
    expect(isPositiveAmount(0n)).toBeFalse()
    expect(isPositiveAmount(-5n)).toBeFalse()
    expect(isPositiveAmount(MAX_DELTA + 1n)).toBeFalse()
  })
})

describe('withKeyLock (per-key FIFO mutex)', () => {
  it('serializes critical sections sharing a key, preserving arrival order', async () => {
    const events: string[] = []

    const sections = ['a', 'b', 'c'].map((label) =>
      withKeyLock('serial', async () => {
        events.push(`start:${label}`)
        await new Promise((resolve) => setTimeout(resolve, 10))
        events.push(`end:${label}`)
        return label
      }),
    )

    const results = await Promise.all(sections)
    expect(results).toEqual(['a', 'b', 'c'])
    // Each section must fully complete before the next one starts.
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c'])
  })

  it('runs different keys in parallel', async () => {
    let inside = 0
    let maxInside = 0

    const sections = ['x', 'y', 'z'].map((key) =>
      withKeyLock(key, async () => {
        inside += 1
        maxInside = Math.max(maxInside, inside)
        await new Promise((resolve) => setTimeout(resolve, 15))
        inside -= 1
      }),
    )

    await Promise.all(sections)
    expect(maxInside).toBe(3) // three distinct keys overlapped
  })

  it('a failing section does not poison the chain for later waiters', async () => {
    const key = 'poison-test'

    const first = withKeyLock(key, async () => {
      throw new Error('section failure')
    })
    expect(first).rejects.toThrow('section failure')

    // The next section on the same key still runs and returns normally.
    const second = await withKeyLock(key, async () => 'recovered')
    expect(second).toBe('recovered')
    await first.catch(() => undefined) // already asserted above
  })

  it('propagates the critical section value and evicts idle keys', async () => {
    const value = await withKeyLock('evict-test', async () => 42)
    expect(value).toBe(42)
    // Give the eviction microtask a tick to run.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(activeLockKeys()).toBe(0)
  })
})
