/**
 * WARLORDS — Energy system (data-driven).
 *
 * Energy gates actions (marching, training boosts, …). Regeneration is
 * resolved LAZILY (lazy-tick model, docs/ARCHITECTURE.md): nothing runs on a
 * timer — every read computes the elapsed regen from `energyUpdatedAt` and
 * persists the result. The pure function below carries the full math so the
 * persistence layer stays trivial.
 */

export const ENERGY = {
  /** Hard cap for a player's energy pool. */
  max: 100,
  /** Energy restored per regeneration tick. */
  regenAmount: 1,
  /** Seconds of real time per regeneration tick. */
  regenIntervalSec: 300,
} as const

if (ENERGY.max <= 0 || ENERGY.regenAmount <= 0 || ENERGY.regenIntervalSec <= 0) {
  throw new Error('Invalid ENERGY config: max, regenAmount, regenIntervalSec must be positive')
}

export interface EnergyStateInput {
  energy: number
  energyUpdatedAt: Date
}

export interface EnergyState {
  energy: number
  energyUpdatedAt: Date
  /** True when the computation changed the state (caller should persist). */
  changed: boolean
  /** Epoch ms until the NEXT point of energy (null at cap or full interval pending). */
  nextRegenAtMs: number | null
}

/**
 * Lazily advances an energy pool to `now`.
 *
 * Rules:
 *  - whole ticks elapsed × regenAmount are restored, capped at max;
 *  - a PARTIAL tick is preserved by advancing the anchor only by the
 *    consumed whole ticks (progress is never lost or double-counted);
 *  - reaching the cap re-anchors to `now` (nothing accumulates at cap);
 *  - energy can never exceed the cap or go below its current value.
 */
export function computeEnergyState(state: EnergyStateInput, now: Date): EnergyState {
  const current = Math.max(0, Math.min(Math.floor(state.energy), ENERGY.max))
  const anchorMs = state.energyUpdatedAt.getTime()
  const elapsedMs = Math.max(0, now.getTime() - anchorMs)
  const intervalMs = ENERGY.regenIntervalSec * 1000

  if (current >= ENERGY.max) {
    return {
      energy: current,
      energyUpdatedAt: new Date(anchorMs),
      changed: false,
      nextRegenAtMs: null,
    }
  }

  const wholeTicks = Math.floor(elapsedMs / intervalMs)
  if (wholeTicks <= 0) {
    return {
      energy: current,
      energyUpdatedAt: new Date(anchorMs),
      changed: false,
      nextRegenAtMs: anchorMs + intervalMs,
    }
  }

  const regenerated = wholeTicks * ENERGY.regenAmount
  const energy = Math.min(current + regenerated, ENERGY.max)
  const atCap = energy >= ENERGY.max

  const newAnchorMs = atCap
    ? now.getTime() // at the cap the anchor resets (no phantom partial tick)
    : anchorMs + wholeTicks * intervalMs // advance by exactly the consumed intervals

  return {
    energy,
    energyUpdatedAt: new Date(newAnchorMs),
    changed: true,
    nextRegenAtMs: atCap ? null : newAnchorMs + intervalMs,
  }
}
