/**
 * Unit tests — XP / Level curve (config/leveling.ts).
 *
 * Invariants of the data-driven system: monotonic requirements, correct
 * level resolution at every boundary, multi-level gains, cap clamping,
 * and rejection of invalid gains.
 */

import { describe, it, expect } from 'bun:test'
import {
  LEVELING,
  XP_REQUIRED_PER_LEVEL,
  CUMULATIVE_XP_BY_LEVEL,
  MAX_TOTAL_XP,
  resolveLevelProgress,
  applyXpGain,
} from '../../../src/lib/game/config/leveling'

describe('LEVELING curve derivation', () => {
  it('derives one requirement per level transition below the cap', () => {
    expect(XP_REQUIRED_PER_LEVEL.length).toBe(LEVELING.maxLevel - 1)
    expect(CUMULATIVE_XP_BY_LEVEL.length).toBe(LEVELING.maxLevel)
  })

  it('starts at baseXp and grows monotonically', () => {
    expect(XP_REQUIRED_PER_LEVEL[0]).toBe(LEVELING.baseXp)
    for (let i = 1; i < XP_REQUIRED_PER_LEVEL.length; i++) {
      const prev = XP_REQUIRED_PER_LEVEL[i - 1]!
      const cur = XP_REQUIRED_PER_LEVEL[i]!
      expect(cur).toBeGreaterThan(prev) // strict growth — flat curves are config bugs
      expect(Number.isInteger(cur)).toBe(true)
    }
  })

  it('builds a consistent cumulative table', () => {
    expect(CUMULATIVE_XP_BY_LEVEL[0]).toBe(0) // level 1 costs nothing
    let running = 0
    for (let i = 0; i < XP_REQUIRED_PER_LEVEL.length; i++) {
      running += XP_REQUIRED_PER_LEVEL[i]!
      expect(CUMULATIVE_XP_BY_LEVEL[i + 1]).toBe(running)
    }
    expect(MAX_TOTAL_XP).toBe(running)
  })
})

describe('resolveLevelProgress', () => {
  it('places zero XP at level 1 with the full first requirement ahead', () => {
    const p = resolveLevelProgress(0)
    expect(p.level).toBe(1)
    expect(p.xpIntoLevel).toBe(0)
    expect(p.xpForNextLevel).toBe(LEVELING.baseXp)
    expect(p.progressBps).toBe(0)
  })

  it('resolves exact level boundaries', () => {
    // Exactly enough XP for level 2 → level 2, progress 0.
    const at2 = resolveLevelProgress(CUMULATIVE_XP_BY_LEVEL[1]!)
    expect(at2.level).toBe(2)
    expect(at2.xpIntoLevel).toBe(0)

    // One XP below the level-3 boundary stays level 2.
    const near3 = resolveLevelProgress(CUMULATIVE_XP_BY_LEVEL[2]! - 1)
    expect(near3.level).toBe(2)
    expect(near3.xpIntoLevel).toBe(near3.xpForNextLevel - 1)
  })

  it('clamps negative and absurd inputs', () => {
    expect(resolveLevelProgress(-500).level).toBe(1)
    expect(resolveLevelProgress(-500).xp).toBe(0)
    const over = resolveLevelProgress(MAX_TOTAL_XP * 10)
    expect(over.xp).toBe(MAX_TOTAL_XP)
    expect(over.level).toBe(LEVELING.maxLevel)
  })

  it('reports 100% progress at the cap with no next requirement', () => {
    const p = resolveLevelProgress(MAX_TOTAL_XP)
    expect(p.level).toBe(LEVELING.maxLevel)
    expect(p.xpForNextLevel).toBe(0)
    expect(p.progressBps).toBe(10_000)
  })

  it('never exceeds the cap for arbitrary huge totals', () => {
    const p = resolveLevelProgress(Number.MAX_SAFE_INTEGER)
    expect(p.level).toBe(LEVELING.maxLevel)
    expect(p.xp).toBe(MAX_TOTAL_XP)
  })
})

describe('applyXpGain', () => {
  it('applies a gain without crossing a boundary', () => {
    const r = applyXpGain(0, 50)
    expect(r.xp).toBe(50)
    expect(r.level).toBe(1)
    expect(r.levelsGained).toBe(0)
    expect(r.leveledUp).toBe(false)
  })

  it('crosses exactly one boundary', () => {
    const r = applyXpGain(0, LEVELING.baseXp)
    expect(r.level).toBe(2)
    expect(r.levelsGained).toBe(1)
    expect(r.leveledUp).toBe(true)
    expect(r.xp).toBe(CUMULATIVE_XP_BY_LEVEL[1]!)
  })

  it('crosses multiple boundaries in one grant', () => {
    const targetLevel = 5
    const needed = CUMULATIVE_XP_BY_LEVEL[targetLevel - 1]!
    const r = applyXpGain(0, needed)
    expect(r.level).toBe(targetLevel)
    expect(r.levelsGained).toBe(targetLevel - 1)
  })

  it('clamps at the cap and reports atMaxLevel', () => {
    const r = applyXpGain(MAX_TOTAL_XP - 1, 10_000)
    expect(r.xp).toBe(MAX_TOTAL_XP)
    expect(r.level).toBe(LEVELING.maxLevel)
    expect(r.atMaxLevel).toBe(true)
    // Further gains keep the cap (no overflow, no level drift).
    const again = applyXpGain(r.xp, 5_000)
    expect(again.xp).toBe(MAX_TOTAL_XP)
    expect(again.level).toBe(LEVELING.maxLevel)
  })

  it('rejects zero, negative, fractional and non-numeric gains', () => {
    expect(() => applyXpGain(0, 0)).toThrow(RangeError)
    expect(() => applyXpGain(0, -10)).toThrow(RangeError)
    expect(() => applyXpGain(0, 1.5)).toThrow(RangeError)
    expect(() => applyXpGain(0, Number.NaN)).toThrow(RangeError)
  })
})
