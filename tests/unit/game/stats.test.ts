/**
 * Unit tests — Statistics catalog normalization (config/stats.ts).
 *
 * The catalog is the tamper-proof boundary between stored JSON and the
 * typed counter record: unknown keys dropped, missing keys zero-filled,
 * non-conforming values rejected.
 */

import { describe, it, expect } from 'bun:test'
import {
  STAT_DEFINITIONS,
  STAT_KEYS,
  STAT_CATEGORIES,
  emptyPlayerStats,
} from '../../../src/lib/game/config/stats'
import { normalizeStoredStats } from '../../../src/lib/game/services/stats.service'

describe('stats catalog', () => {
  it('defines unique, non-empty keys with valid categories', () => {
    const keys = STAT_DEFINITIONS.map((d) => d.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const def of STAT_DEFINITIONS) {
      expect(def.label.length).toBeGreaterThan(0)
      expect(STAT_CATEGORIES).toContain(def.category)
    }
    expect(STAT_KEYS.length).toBeGreaterThan(0)
  })

  it('zero-fills the full record', () => {
    const stats = emptyPlayerStats()
    expect(Object.keys(stats).length).toBe(STAT_DEFINITIONS.length)
    for (const value of Object.values(stats)) expect(value).toBe(0)
  })
})

describe('normalizeStoredStats (defensive read path)', () => {
  it('returns zeros for null/undefined/corrupt blobs', () => {
    expect(normalizeStoredStats(null)).toEqual(emptyPlayerStats())
    expect(normalizeStoredStats(undefined)).toEqual(emptyPlayerStats())
    expect(normalizeStoredStats('garbage')).toEqual(emptyPlayerStats())
    expect(normalizeStoredStats([1, 2, 3])).toEqual(emptyPlayerStats())
    expect(normalizeStoredStats(42)).toEqual(emptyPlayerStats())
  })

  it('drops unknown keys (no smuggling of fake counters)', () => {
    const stats = normalizeStoredStats({ battlesWon: 5, hackerStat: 999 })
    expect(stats['battlesWon']).toBe(5)
    expect(stats['hackerStat']).toBeUndefined()
    expect(Object.keys(stats).length).toBe(STAT_DEFINITIONS.length)
  })

  it('zero-fills missing keys and rejects non-conforming values', () => {
    const stats = normalizeStoredStats({
      battlesWon: 3,
      battlesLost: -4, // negative → rejected
      unitsTrained: 2.5, // fractional → rejected
      unitsLost: 'seven', // wrong type → rejected
      resourcesCollected: Number.NaN, // NaN → rejected
    })
    expect(stats['battlesWon']).toBe(3)
    expect(stats['battlesLost']).toBe(0)
    expect(stats['unitsTrained']).toBe(0)
    expect(stats['unitsLost']).toBe(0)
    expect(stats['resourcesCollected']).toBe(0)
  })

  it('accepts conforming counters and full records unchanged', () => {
    const full = emptyPlayerStats()
    full['questsCompleted'] = 12
    expect(normalizeStoredStats(full)).toEqual(full)
  })
})
