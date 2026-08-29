/**
 * Unit tests — Energy lazy regeneration (config/energy.ts).
 *
 * The lazy-tick math: whole-tick regen, partial-tick carry, cap behavior,
 * and the "no change" fast path that keeps reads cheap.
 */

import { describe, it, expect } from 'bun:test'
import { computeEnergyState, ENERGY } from '../../../src/lib/game/config/energy'

const SEC = 1000
const t0 = new Date(1_700_000_000_000)

describe('computeEnergyState', () => {
  it('is a no-op when less than one interval has elapsed', () => {
    const state = computeEnergyState(
      { energy: 50, energyUpdatedAt: t0 },
      new Date(t0.getTime() + (ENERGY.regenIntervalSec - 1) * SEC),
    )
    expect(state.energy).toBe(50)
    expect(state.changed).toBe(false)
    expect(state.energyUpdatedAt.getTime()).toBe(t0.getTime())
    expect(state.nextRegenAtMs).toBe(t0.getTime() + ENERGY.regenIntervalSec * SEC)
  })

  it('restores whole ticks and preserves the partial interval', () => {
    // 2.5 intervals elapsed → +2 energy, anchor advanced exactly 2 intervals.
    const now = new Date(t0.getTime() + 2.5 * ENERGY.regenIntervalSec * SEC)
    const state = computeEnergyState({ energy: 50, energyUpdatedAt: t0 }, now)
    expect(state.energy).toBe(52)
    expect(state.changed).toBe(true)
    expect(state.energyUpdatedAt.getTime()).toBe(t0.getTime() + 2 * ENERGY.regenIntervalSec * SEC)
    expect(state.nextRegenAtMs).toBe(t0.getTime() + 3 * ENERGY.regenIntervalSec * SEC)
  })

  it('caps at max and re-anchors to now', () => {
    // 1000 ticks requested but only 50 fit below the cap.
    const now = new Date(t0.getTime() + 1000 * ENERGY.regenIntervalSec * SEC)
    const state = computeEnergyState({ energy: 50, energyUpdatedAt: t0 }, now)
    expect(state.energy).toBe(ENERGY.max)
    expect(state.energyUpdatedAt.getTime()).toBe(now.getTime())
    expect(state.nextRegenAtMs).toBeNull()
  })

  it('never regenerates above the configured cap', () => {
    const now = new Date(t0.getTime() + 100 * ENERGY.regenIntervalSec * SEC)
    const state = computeEnergyState({ energy: ENERGY.max, energyUpdatedAt: t0 }, now)
    expect(state.energy).toBe(ENERGY.max)
    expect(state.changed).toBe(false)
  })

  it('coerces out-of-range stored energy into [0, max]', () => {
    const now = new Date(t0.getTime())
    const over = computeEnergyState({ energy: 500, energyUpdatedAt: t0 }, now)
    expect(over.energy).toBe(ENERGY.max)
    const negative = computeEnergyState({ energy: -7, energyUpdatedAt: t0 }, now)
    expect(negative.energy).toBe(0)
  })

  it('is deterministic for the same inputs', () => {
    const now = new Date(t0.getTime() + 7 * ENERGY.regenIntervalSec * SEC)
    const a = computeEnergyState({ energy: 10, energyUpdatedAt: t0 }, now)
    const b = computeEnergyState({ energy: 10, energyUpdatedAt: t0 }, now)
    expect(a).toEqual(b)
  })
})
