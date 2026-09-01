/**
 * WARLORDS — Economy configuration (Phase 5: Resource & Economy Engine).
 *
 * The ONLY place economy balance numbers live (ARCHITECTURE.md rule): caps,
 * arithmetic bounds, ledger-page sizing and idempotency TTL are defined here
 * and consumed by the economy service — rebalancing never touches logic.
 *
 * Economy resources are the six tradable currencies a player holds:
 *   GOLD · WOOD · IRON · FOOD · CRYSTAL  → stored on ResourceWallet (the cache)
 *   GEMS                                 → premium currency stored on Player
 * Both storage targets flow through the SAME ledger (resource_transactions),
 * so `Σ(delta) == balance` reconciles per resource regardless of storage.
 *
 * Numeric policy (ARCHITECTURE.md §4.4): balances are BigInt; percentages
 * would be basis points. Overflow is IMPOSSIBLE by construction — BigInt has
 * no wrap-around, and every credit is clamped to the resource cap below.
 */

import { RESOURCES } from '@/lib/game/types/common'

/** The six canonical economy resources (wallet five + premium GEMS). */
export const ECONOMY_RESOURCES = [...RESOURCES, 'GEMS'] as const
export type EconomyResource = (typeof ECONOMY_RESOURCES)[number]

// ── Balance arithmetic bounds ─────────────────────────────────────────────────

/**
 * Per-resource maximum balance. Credits beyond the cap are clamped to it —
 * "overflow-safe" means the exact cap is never exceeded and the clamped
 * (actually applied) delta is what the ledger records, so the ledger always
 * reconciles to the stored balance.
 */
export const RESOURCE_CAPS: Record<EconomyResource, bigint> = {
  GOLD: 5_000_000_000n, // 5e9 — primary currency
  WOOD: 2_500_000_000n,
  IRON: 2_500_000_000n,
  FOOD: 2_500_000_000n,
  CRYSTAL: 1_000_000_000n, // rare crafting material
  GEMS: 100_000_000n, // premium — intentionally the tightest cap
}

/**
 * Hard arithmetic ceiling for a single mutation. Any |delta| above this is
 * rejected as INVALID_AMOUNT before any math happens. Well below
 * Number.MAX_SAFE_INTEGER so amounts stay representable for client display
 * math, and far above every cap (caps always win first).
 */
export const MAX_DELTA = 1_000_000_000_000_000n // 1e15

// ── Ledger history paging ─────────────────────────────────────────────────────

export const ECONOMY_HISTORY = {
  defaultPageSize: 25,
  maxPageSize: 100,
} as const

// ── Grant idempotency ─────────────────────────────────────────────────────────

/**
 * How long a resource-grant idempotency key stays recorded. Within the TTL a
 * replayed grant (retry, double-claim) returns the ORIGINAL result instead of
 * paying out twice. Idempotency rows are written in the SAME transaction as
 * the grant, so grant+key commit or roll back atomically.
 */
export const GRANT_IDEMPOTENCY_TTL_SECONDS = 86_400 // 24h

// ── Ledger reason catalog ─────────────────────────────────────────────────────

/**
 * The closed vocabulary of ledger reasons. EVERY resource mutation must carry
 * exactly one of these — unknown reasons are rejected at the write path, and
 * the history endpoint filters by the same set. Adding an economy subsystem
 * means adding its reason HERE first (data-driven contract).
 */
export const LEDGER_REASONS = [
  'BOOTSTRAP', // first-login faucet (player-bootstrap.service)
  'QUEST_REWARD', // quest claim payouts
  'ACHIEVEMENT_REWARD', // achievement unlock payouts (Phase 31, auto-granted)
  'BUILDING_UPGRADE', // construction/upgrade costs (debit)
  'UNIT_TRAINING', // barracks costs (debit)
  'BATTLE_REWARD', // battle loot transfers
  'TERRITORY_CAPTURE', // territory assault spoils (Phase 32, credit)
  'TERRITORY_PRODUCTION', // lazy territory production collection (Phase 32, credit)
  'MARKET_PURCHASE', // player-market buys (debit buyer)
  'MARKET_SALE', // player-market sales (credit seller)
  'ADMIN_ADJUSTMENT', // audited support/ops corrections (either sign)
  'SEASON_REWARD', // seasonal ranking payout at claim (credit)
] as const
export type LedgerReason = (typeof LEDGER_REASONS)[number]

// ── Pure arithmetic helpers (no I/O, no AppError — services translate) ───────

export interface CreditResult {
  balanceAfter: bigint
  /** The delta actually applied (may be smaller than requested when clamped). */
  applied: bigint
  /** True when the cap truncated the requested credit. */
  capped: boolean
}

/** Credits `current` by a positive `delta`, clamping at `cap`. */
export function creditWithCap(current: bigint, delta: bigint, cap: bigint): CreditResult {
  const requested = current + delta
  const balanceAfter = requested > cap ? cap : requested
  return { balanceAfter, applied: balanceAfter - current, capped: balanceAfter !== requested }
}

export type DebitResult = { ok: true; balanceAfter: bigint } | { ok: false; balanceAfter: bigint }

/** Debits `current` by a positive `amount`, refusing to go below zero. */
export function debitBalance(current: bigint, amount: bigint): DebitResult {
  if (amount > current) return { ok: false, balanceAfter: current }
  return { ok: true, balanceAfter: current - amount }
}

/** Validated-shape predicate for a single resource delta (≠ 0, within bounds). */
export function isEconomyDelta(delta: bigint): boolean {
  return delta !== 0n && delta >= -MAX_DELTA && delta <= MAX_DELTA
}

/** True for positive BigInt amounts within the single-mutation ceiling. */
export function isPositiveAmount(amount: bigint): boolean {
  return amount > 0n && amount <= MAX_DELTA
}
