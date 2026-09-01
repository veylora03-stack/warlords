/**
 * WARLORDS — Quest engine, PURE layer (Phase 31: Quest + Achievement Engine).
 *
 * Pure functions only — no I/O, no Prisma, no clock reads (every function
 * takes `now` or its products as input; the caller's transaction owns the
 * server clock). The service layer (quest-events.service / quest.service)
 * orchestrates these against the database inside the CALLER'S transaction.
 *
 * SECURITY: the client can never influence any input here. Events are built
 * exclusively from server-side state (battle outcomes, ledger writes,
 * building rows, queue completions, player columns) inside the transaction
 * that mutated that state.
 */

import { OBJECTIVE_PROGRESS_MODES, type ObjectiveType } from '@/lib/game/config/quests'
import { ECONOMY_RESOURCES, type EconomyResource } from '@/lib/game/config/economy'
import type { RewardKey } from '@/lib/game/config/quests'
import type { QuestStatus, QuestType } from '@/lib/game/types/common'

// ── Quest events (the typed event union consumed by the engine) ──────────────

export type QuestEvent =
  | { kind: 'BATTLE_FINISHED'; won: boolean; role: 'ATTACKER' | 'DEFENDER'; battleId: string }
  | { kind: 'BUILDING_UPGRADED'; buildingType: string; level: number; buildingId: string }
  | { kind: 'UNITS_TRAINED'; unitId: string; count: number; queueItemId: string }
  | { kind: 'RESOURCES_EARNED'; amounts: Record<string, number>; sourceRef: string }
  | { kind: 'RESOURCES_SPENT'; amounts: Record<string, number>; sourceRef: string }
  | { kind: 'POWER_REACHED'; power: number }
  | { kind: 'LEVEL_REACHED'; level: number }
  // Phase 32 — territory domain events (raised by world.service INSIDE the
  // transaction that changed ownership; never client-constructible):
  | {
      kind: 'TERRITORY_CAPTURED'
      territoryId: string
      regionId: string | null
      /** Server-computed territory count of the capturer AFTER the capture. */
      ownedCount: number
      battleId: string
    }
  | { kind: 'TERRITORY_DEFENDED'; territoryId: string; battleId: string }
  | { kind: 'TERRITORY_LOST'; territoryId: string; battleId: string }

export type QuestEventKind = QuestEvent['kind']

/** Audit identity of an event — stored on PlayerQuest.lastEventKey. */
export function questEventKey(event: QuestEvent): string {
  switch (event.kind) {
    case 'BATTLE_FINISHED':
      return `BATTLE_FINISHED:battle:${event.battleId}:${event.role}`
    case 'BUILDING_UPGRADED':
      return `BUILDING_UPGRADED:building:${event.buildingId}:${event.level}`
    case 'UNITS_TRAINED':
      return `UNITS_TRAINED:queue:${event.queueItemId}`
    case 'RESOURCES_EARNED':
    case 'RESOURCES_SPENT':
      return `${event.kind}:${event.sourceRef}`
    case 'POWER_REACHED':
      return `POWER_REACHED:${event.power}`
    case 'LEVEL_REACHED':
      return `LEVEL_REACHED:${event.level}`
    case 'TERRITORY_CAPTURED':
      // One battle captures at most one territory — the battle id is the
      // event identity, so idempotent replays can never re-advance progress.
      return `TERRITORY_CAPTURED:battle:${event.battleId}`
    case 'TERRITORY_DEFENDED':
      return `TERRITORY_DEFENDED:battle:${event.battleId}`
    case 'TERRITORY_LOST':
      return `TERRITORY_LOST:battle:${event.battleId}`
  }
}

// ── Objective matching ────────────────────────────────────────────────────────

interface ObjectiveTargetLike {
  unitId?: unknown
  buildingType?: unknown
  resource?: unknown
  level?: unknown
  amount?: unknown
}

/**
 * Does this event advance a quest whose objective is (objectiveType, target)?
 * Filters are strict: a quest gated on buildingType/unitId/resource only
 * matches events for that exact catalog entity.
 */
export function matchesObjective(
  objectiveType: string,
  target: ObjectiveTargetLike,
  event: QuestEvent,
): boolean {
  switch (objectiveType) {
    case 'WIN_BATTLES':
      return event.kind === 'BATTLE_FINISHED' && event.won
    case 'BUILD_UPGRADE': {
      if (event.kind !== 'BUILDING_UPGRADED') return false
      if (typeof target.buildingType === 'string' && event.buildingType !== target.buildingType)
        return false
      const minLevel = typeof target.level === 'number' ? target.level : null
      if (minLevel !== null && event.level < minLevel) return false
      return true
    }
    case 'TRAIN_UNITS': {
      if (event.kind !== 'UNITS_TRAINED') return false
      if (typeof target.unitId === 'string' && event.unitId !== target.unitId) return false
      return true
    }
    case 'EARN_RESOURCE': {
      if (event.kind !== 'RESOURCES_EARNED') return false
      if (typeof target.resource === 'string') return (event.amounts[target.resource] ?? 0) > 0
      return Object.values(event.amounts).some((n) => n > 0)
    }
    case 'SPEND_RESOURCE': {
      if (event.kind !== 'RESOURCES_SPENT') return false
      if (typeof target.resource === 'string') return (event.amounts[target.resource] ?? 0) > 0
      return Object.values(event.amounts).some((n) => n > 0)
    }
    case 'REACH_POWER':
      return event.kind === 'POWER_REACHED'
    case 'REACH_LEVEL':
      return event.kind === 'LEVEL_REACHED'
    case 'CAPTURE_TERRITORIES':
      return event.kind === 'TERRITORY_CAPTURED'
    case 'CONTROL_TERRITORIES':
      // SET objective — progress snaps to the capturer's CURRENT owned count.
      return event.kind === 'TERRITORY_CAPTURED'
    case 'DEFEND_TERRITORIES':
      return event.kind === 'TERRITORY_DEFENDED'
    // Reserved extension points (Clan, Scout): no events exist yet, so
    // nothing can ever match — quests using them stay inert.
    default:
      return false
  }
}

/**
 * The numeric contribution a matching event makes (INCREMENT objectives), or
 * the value progress snaps to (SET objectives). Callsites guarantee the
 * objective matches the event; a mismatch throws (programmer error).
 */
export function eventContribution(
  objectiveType: ObjectiveType,
  target: ObjectiveTargetLike,
  event: QuestEvent,
): { mode: 'INCREMENT'; delta: number } | { mode: 'SET'; value: number } {
  const mode = OBJECTIVE_PROGRESS_MODES[objectiveType]
  if (mode === 'SET') {
    if (event.kind === 'POWER_REACHED') return { mode, value: event.power }
    if (event.kind === 'LEVEL_REACHED') return { mode, value: event.level }
    if (event.kind === 'TERRITORY_CAPTURED') return { mode, value: event.ownedCount }
    throw new Error(`SET objective ${objectiveType} cannot consume event ${event.kind}`)
  }
  // INCREMENT
  switch (event.kind) {
    case 'BATTLE_FINISHED':
      return { mode, delta: 1 }
    case 'BUILDING_UPGRADED':
      return { mode, delta: 1 }
    case 'UNITS_TRAINED':
      return { mode, delta: event.count }
    case 'TERRITORY_CAPTURED':
      return { mode, delta: 1 }
    case 'TERRITORY_DEFENDED':
      return { mode, delta: 1 }
    case 'RESOURCES_EARNED':
    case 'RESOURCES_SPENT': {
      const resource = typeof target.resource === 'string' ? target.resource : null
      if (resource !== null) return { mode, delta: event.amounts[resource] ?? 0 }
      return {
        mode,
        delta: Object.values(event.amounts).reduce<number>((sum, n) => sum + (n > 0 ? n : 0), 0),
      }
    }
    default:
      throw new Error(`INCREMENT objective ${objectiveType} cannot consume event ${event.kind}`)
  }
}

/**
 * Applies a contribution to current progress — pure, clamped, monotonic:
 *  - INCREMENT: bounded by target (progress never overshoots — a 500-unit
 *    training batch against a 20-unit daily quest completes at exactly 20).
 *  - SET: never decreases (a power drop cannot un-complete a quest).
 * Completion requires progress >= target AND target >= 1.
 */
export function applyContribution(
  current: number,
  target: number,
  contribution: { mode: 'INCREMENT'; delta: number } | { mode: 'SET'; value: number },
): { progress: number; completed: boolean } {
  if (!Number.isInteger(current) || current < 0 || !Number.isInteger(target) || target < 1) {
    throw new Error(`Corrupt quest state: progress=${current} target=${target}`)
  }
  let progress: number
  if (contribution.mode === 'INCREMENT') {
    if (!Number.isInteger(contribution.delta) || contribution.delta < 0) {
      throw new Error(`Invalid quest delta: ${contribution.delta}`)
    }
    progress = Math.min(target, current + contribution.delta)
  } else {
    if (!Number.isInteger(contribution.value) || contribution.value < 0) {
      throw new Error(`Invalid quest SET value: ${contribution.value}`)
    }
    progress = Math.min(target, Math.max(current, contribution.value))
  }
  return { progress, completed: progress >= target }
}

// ── Cycles & expiry (server UTC clock only) ──────────────────────────────

/** DAILY cycle id: UTC calendar date 'YYYY-MM-DD'. */
export function dailyCycleAt(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/** WEEKLY cycle id: ISO-8601 week in UTC, 'YYYY-Wnn' (Monday-based). */
export function weeklyCycleAt(now: Date): string {
  // ISO weekday: Mon=0 … Sun=6
  const isoDow = (d: Date): number => (d.getUTCDay() + 6) % 7
  // Thursday of the Monday-based week containing d (canonical ISO anchor).
  const thursdayOfWeek = (d: Date): Date => {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    t.setUTCDate(t.getUTCDate() - isoDow(t) + 3)
    return t
  }
  const thursday = thursdayOfWeek(now)
  // ISO year = year of the week's Thursday; week 1 contains Jan 4.
  const jan4 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4))
  const firstThursday = thursdayOfWeek(jan4)
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86_400_000))
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

interface SeasonLike {
  number: number
  endsAt: Date
}

/**
 * The assignment cycle for a quest type at time `now`:
 *  - DAILY    → UTC date
 *  - WEEKLY   → ISO week
 *  - SEASONAL → season number (a season row is REQUIRED — caller resolves)
 *  - others   → '0' (permanent single instance)
 */
export function cycleForType(type: QuestType, now: Date, season: SeasonLike | null): string | null {
  switch (type) {
    case 'DAILY':
      return dailyCycleAt(now)
    case 'WEEKLY':
      return weeklyCycleAt(now)
    case 'SEASONAL':
      return season ? String(season.number) : null // null → no active season → not assignable
    default:
      return '0'
  }
}

/**
 * Instance expiry for a quest type: DAILY/WEEKLY instances expire at the
 * NEXT cycle boundary; SEASONAL at season end; permanent never expire.
 */
export function expiresAtForType(
  type: QuestType,
  now: Date,
  season: SeasonLike | null,
): Date | null {
  switch (type) {
    case 'DAILY': {
      const next = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        0,
        0,
        0,
        0,
      )
      return new Date(next)
    }
    case 'WEEKLY': {
      const day = (now.getUTCDay() + 6) % 7 // Mon=0 … Sun=6
      const nextMonday = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - day + 7,
        0,
        0,
        0,
        0,
      )
      return new Date(nextMonday)
    }
    case 'SEASONAL':
      return season ? season.endsAt : null
    default:
      return null
  }
}

/** Lazy-expiry check: an ACTIVE instance past its expiry is EXPIRED. */
export function isExpired(status: string, expiresAt: Date | null, now: Date): boolean {
  return status === 'ACTIVE' && expiresAt !== null && expiresAt.getTime() <= now.getTime()
}

/** Statuses eligible for progress writes. */
export function isProgressable(status: QuestStatus | string): boolean {
  return status === 'ACTIVE'
}

/** A COMPLETED instance whose reward is not yet claimed. */
export function isClaimable(status: QuestStatus | string): boolean {
  return status === 'COMPLETED'
}

// ── Rewards ──────────────────────────────────────────────────────────────

export interface SplitReward {
  wallet: Partial<Record<EconomyResource, number>>
  xp: number
  honor: number
  /** Reward keys present in the definition that the claim pipeline cannot fulfill. */
  unsupported: RewardKey[]
}

/**
 * Splits a quest/achievement reward JSON into claimable channels. Wallet
 * resources go through the Economy/Ledger, XP through progression, HONOR
 * through the player column — the caller grants each in its transaction.
 * Unknown or not-yet-implemented keys surface in `unsupported` so the claim
 * can FAIL CLOSED instead of silently shrinking a reward.
 */
export function splitReward(raw: unknown): SplitReward {
  const result: SplitReward = { wallet: {}, xp: 0, honor: 0, unsupported: [] }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return result
  const KNOWN_KEYS: ReadonlySet<string> = new Set([
    'GOLD',
    'WOOD',
    'IRON',
    'FOOD',
    'CRYSTAL',
    'GEMS',
    'XP',
    'HONOR',
  ])
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // Unknown keys are flagged REGARDLESS of their value — a reward can never
    // silently shrink because a key carried a malformed amount.
    if (!KNOWN_KEYS.has(key)) {
      result.unsupported.push(key as RewardKey)
      continue
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) continue
    switch (key) {
      case 'GOLD':
      case 'WOOD':
      case 'IRON':
      case 'FOOD':
      case 'CRYSTAL':
      case 'GEMS': {
        if (!ECONOMY_RESOURCES.includes(key as EconomyResource)) {
          result.unsupported.push(key as RewardKey)
          break
        }
        result.wallet[key as EconomyResource] = value
        break
      }
      case 'XP':
        result.xp = value
        break
      case 'HONOR':
        result.honor = value
        break
    }
  }
  return result
}

/** Human-readable reward summary for notifications (server-rendered). */
export function summarizeReward(raw: unknown): string | undefined {
  const split = splitReward(raw)
  const parts: string[] = []
  for (const [resource, amount] of Object.entries(split.wallet)) {
    if (amount > 0) parts.push(`${amount} ${resource}`)
  }
  if (split.xp > 0) parts.push(`${split.xp} XP`)
  if (split.honor > 0) parts.push(`${split.honor} Honor`)
  if (parts.length === 0) return undefined
  return `Reward: ${parts.join(', ')}.`
}
