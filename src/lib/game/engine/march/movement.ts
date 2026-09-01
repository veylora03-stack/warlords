/**
 * WARLORDS — March engine, PURE layer (Phase 33: March & Army Movement).
 *
 * Pure functions only — no I/O, no Prisma, no clock reads. Every function
 * takes its inputs explicitly; the service layer (march.service) orchestrates
 * them against the database inside the CALLER'S transaction.
 *
 * SECURITY: the client can never influence any input here. Stacks are
 * validated against the REAL unit catalog and the player's REAL rows; the
 * state machine below is the single legality oracle for every transition the
 * service may attempt (invalid transitions throw — programmer error or
 * race, never silent corruption).
 */

import { MARCH } from '@/lib/game/config/march'
import type { MarchStatus, MarchType } from '@/lib/game/types/common'

// ── Distance ─────────────────────────────────────────────────────────────────

export interface CellCoord {
  x: number
  y: number
}

/**
 * MANHATTAN distance — the march metric of this world. Territory adjacency
 * is 4-directional (N/S/E/W, Phase 32); there is no diagonal movement, so an
 * army's path length is exactly |dx| + |dy|. Chebyshev would imply diagonal
 * moves that do not exist here and is deliberately NOT used.
 */
export function manhattanDistance(a: CellCoord, b: CellCoord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
}

// ── Army stacks (reservation manifests & survivors) ──────────────────────────

/** The immutable JSON shape stored on March.units / March.survivors. */
export interface MarchStack {
  unitId: string
  count: number
}

/** Canonicalizes + validates the client-supplied units array (pure). */
export function parseMarchStacks(raw: unknown): MarchStack[] {
  if (!Array.isArray(raw)) throw new Error('units must be an array')
  if (raw.length === 0) throw new Error('units must not be empty')
  if (raw.length > MARCH.maxStacksPerMarch) {
    throw new Error(`units must not exceed ${MARCH.maxStacksPerMarch} stacks`)
  }
  const stacks = new Map<string, number>()
  let total = 0
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('every unit entry must be an object')
    }
    const unitId = (entry as { unitId?: unknown }).unitId
    const count = (entry as { count?: unknown }).count
    if (typeof unitId !== 'string' || unitId.length === 0 || unitId.length > 64) {
      throw new Error('unitId must be a 1..64 character string')
    }
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
      throw new Error('count must be a positive integer')
    }
    if (stacks.has(unitId)) throw new Error(`duplicate unit stack: ${unitId}`)
    stacks.set(unitId, count)
    total += count
    if (total > MARCH.maxUnitsPerMarch) {
      throw new Error(`march exceeds ${MARCH.maxUnitsPerMarch} total units`)
    }
  }
  return [...stacks.entries()]
    .map(([unitId, count]) => ({ unitId, count }))
    .sort((a, b) => (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0))
}

/** Total units across stacks. */
export function totalUnits(stacks: readonly MarchStack[]): number {
  return stacks.reduce((sum, stack) => sum + stack.count, 0)
}

/**
 * The slowest catalog speed across the stacks — the march pace is set by its
 * slowest unit. Unknown unit ids throw (the service has already validated
 * against the catalog; this is a fail-closed backstop for corrupt manifests).
 */
export function slowestArmySpeed(
  stacks: readonly MarchStack[],
  catalogSpeeds: ReadonlyMap<string, number>,
): number {
  let speed: number | null = null
  for (const stack of stacks) {
    const unitSpeed = catalogSpeeds.get(stack.unitId)
    if (typeof unitSpeed !== 'number' || unitSpeed < 1) {
      throw new Error(`unknown unit in march manifest: ${stack.unitId}`)
    }
    speed = speed === null ? unitSpeed : Math.min(speed, unitSpeed)
  }
  if (speed === null) throw new Error('march manifest is empty')
  return speed
}

/** Merges stacks (used when restoring reserved units). */
export function mergeStacks(a: readonly MarchStack[], b: readonly MarchStack[]): MarchStack[] {
  const merged = new Map<string, number>()
  for (const stack of [...a, ...b]) {
    merged.set(stack.unitId, (merged.get(stack.unitId) ?? 0) + stack.count)
  }
  return [...merged.entries()]
    .map(([unitId, count]) => ({ unitId, count }))
    .sort((x, y) => (x.unitId < y.unitId ? -1 : x.unitId > y.unitId ? 1 : 0))
}

/**
 * Committed − losses = survivors (pure march-casualty algebra). Losses for
 * unit ids that are not in the committed manifest throw — the battle
 * simulator can only lose units it was given.
 */
export function subtractStacks(
  committed: readonly MarchStack[],
  losses: readonly { unitTypeId: string; count: number }[],
): MarchStack[] {
  const remaining = new Map<string, number>(committed.map((s) => [s.unitId, s.count]))
  for (const loss of losses) {
    const current = remaining.get(loss.unitTypeId)
    if (current === undefined) {
      throw new Error(`loss for uncommitted unit: ${loss.unitTypeId}`)
    }
    if (loss.count > current) {
      throw new Error(`loss exceeds committed units for ${loss.unitTypeId}`)
    }
    remaining.set(loss.unitTypeId, current - loss.count)
  }
  return [...remaining.entries()]
    .filter(([, count]) => count > 0)
    .map(([unitId, count]) => ({ unitId, count }))
    .sort((a, b) => (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0))
}

/**
 * Parses a stored manifest (March.units / March.survivors JSON) with
 * fail-closed validation — a corrupt manifest is an INTERNAL error, never
 * silently coerced.
 */
export function readStoredStacks(raw: unknown): MarchStack[] {
  const stacks = parseMarchStacks(raw)
  for (const stack of stacks) {
    if (!Number.isInteger(stack.count) || stack.count < 1) {
      throw new Error('corrupt march manifest: invalid count')
    }
  }
  return stacks
}

// ── State machine ────────────────────────────────────────────────────────────

/**
 * The march state machine — EXPLICIT legal transitions (server oracle):
 *
 *   EN_ROUTE  → RESOLVING   (arrival processing claim — exactly-once arbiter)
 *   EN_ROUTE  → CANCELLED   (player recall while traveling)
 *   RESOLVING → RETURNING   (arrival resolved; survivors head home)
 *   RESOLVING → COMPLETED   (mission delivered — DEFEND/REINFORCE restore)
 *   RESOLVING → LOST        (every committed unit died at the destination)
 *   RETURNING → RESOLVING   (homecoming processing claim)
 *
 * Terminals: COMPLETED | CANCELLED | LOST (and the reserved ARRIVED).
 */
export const MARCH_TRANSITIONS: Readonly<Record<MarchStatus, readonly MarchStatus[]>> = {
  EN_ROUTE: ['RESOLVING', 'CANCELLED'],
  RESOLVING: ['RETURNING', 'COMPLETED', 'LOST'],
  RETURNING: ['RESOLVING'],
  ARRIVED: [], // reserved — never persisted by this engine
  COMPLETED: [],
  CANCELLED: [],
  LOST: [],
}

export function isMarchTransition(from: MarchStatus, to: MarchStatus): boolean {
  return MARCH_TRANSITIONS[from].includes(to)
}

/** Terminal states — no further writes ever happen to these rows. */
export function isTerminalMarchStatus(status: MarchStatus): boolean {
  return MARCH_TRANSITIONS[status].length === 0 && status !== 'ARRIVED'
}

/** Statuses that count against the player's march-slot capacity. */
export const ACTIVE_MARCH_STATUSES: readonly MarchStatus[] = ['EN_ROUTE', 'RESOLVING', 'RETURNING']

/** Whether the march can be recalled right now (CANCEL is EN_ROUTE-only). */
export function isCancellable(status: MarchStatus): boolean {
  return status === 'EN_ROUTE'
}

/** March actions the CLIENT may request (RETURN is engine-internal). */
export const CLIENT_MARCH_TYPES: readonly MarchType[] = ['ATTACK', 'DEFEND', 'SCOUT', 'REINFORCE']
