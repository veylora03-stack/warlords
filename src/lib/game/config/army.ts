/**
 * WARLORDS — Army training policy (Phase 7: Army & Unit System).
 *
 * The ONLY place recruitment balance/policy numbers live (ARCHITECTURE.md
 * rule): queue depth, batch ceilings and the cancellation refund matrix are
 * defined here and consumed by the army service — rebalancing never touches
 * logic. The client supplies ONLY a unit id and a quantity; every other
 * number (cost, duration, speed, refund) is resolved server-side.
 *
 * Numeric policy: refunds are BASIS POINTS of the paid cost (10_000 bps =
 * 100%); queue timing uses integer milliseconds with bps-derived training
 * speed — no floating point anywhere (ARCHITECTURE.md §4.4).
 */

/** Queue depth, batch ceiling and refund matrix for unit training. */
export const ARMY_TRAINING = {
  /** Max simultaneous TRAINING queue items per player (FIFO across buildings). */
  queueSlots: 5,
  /** Per-recruit quantity ceiling — one queue item trains at most this many units. */
  maxUnitsPerBatch: 1_000,
  /** Refund (bps of the paid cost) when the batch has NOT started training. */
  notStartedRefundBps: 10_000, // 100%
  /** Refund (bps of the paid cost) once the batch has started training. */
  inProgressRefundBps: 5_000, // 50%
  /** Basis-point denominator (10_000 bps = 100%) — pure readability export. */
  bpsDenominator: 10_000,
} as const

export type ArmyTrainingPolicy = typeof ARMY_TRAINING
