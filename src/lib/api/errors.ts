/**
 * WARLORDS — Application error taxonomy.
 *
 * Every expected failure flows through AppError → response.ts mapper →
 * consistent envelope + structured log. Unexpected failures become
 * INTERNAL_ERROR (500) with the stack logged server-side, never leaked.
 */

import type { ReputationLevel } from '@/lib/game/types/common'

export const ERROR_CODES = {
  // Auth (401)
  UNAUTHORIZED: 401,
  INVALID_INIT_DATA: 401,
  SESSION_EXPIRED: 401,
  SESSION_REVOKED: 401,
  BANNED: 403,
  // Auth infrastructure (503) — misconfigured server, not a client fault
  AUTH_NOT_CONFIGURED: 503,
  // Permission (403)
  FORBIDDEN: 403,
  CLAN_ROLE_REQUIRED: 403,
  PROTECTED_TARGET: 403,
  SELF_TARGET: 400,
  // Validation (400)
  VALIDATION_ERROR: 400,
  INVALID_TARGET: 400,
  INVALID_AMOUNT: 400,
  ARMY_EMPTY: 400,
  // State (409 / 429)
  INSUFFICIENT_GOLD: 409,
  INSUFFICIENT_WOOD: 409,
  INSUFFICIENT_IRON: 409,
  INSUFFICIENT_FOOD: 409,
  INSUFFICIENT_CRYSTAL: 409,
  INSUFFICIENT_GEMS: 409,
  INSUFFICIENT_ENERGY: 409,
  INSUFFICIENT_UNITS: 409,
  WAREHOUSE_FULL: 409,
  BUILDING_QUEUE_BUSY: 409,
  PREREQUISITE_MISSING: 409,
  MAX_LEVEL_REACHED: 409,
  CONSTRUCTION_IN_PROGRESS: 409,
  CONSTRUCTION_NOT_COMPLETE: 409,
  CONSTRUCTION_NOT_ACTIVE: 409,
  ALREADY_IN_CLAN: 409,
  NOT_IN_CLAN: 409,
  ORDER_NO_LONGER_OPEN: 409,
  ACTION_ON_COOLDOWN: 429,
  RATE_LIMITED: 429,
  IDEMPOTENT_REPLAY: 409,
  // Army training (409)
  TRAINING_QUEUE_FULL: 409,
  TRAINING_NOT_COMPLETE: 409,
  TRAINING_NOT_ACTIVE: 409,
  // Seasons (Phase 20)
  SEASON_NOT_SETTLED: 409,
  SEASON_NOT_ACTIVE: 409,
  SEASON_ALREADY_SETTLED: 409,
  SETTLEMENT_NOT_PENDING: 409,
  TITLE_NOT_OWNED: 409,
  ADMIN_REQUIRED: 403,
  // Admin panel (Phase 21)
  ADMIN_FORBIDDEN: 403,
  PLAYER_ALREADY_BANNED: 409,
  PLAYER_NOT_BANNED: 409,
  EVENT_NOT_ACTIVE: 409,
  EVENT_WINDOW_INVALID: 400,
  CLAN_HAS_WARS: 409,
  CONFIRMATION_REQUIRED: 400,
  ANNOUNCEMENT_INACTIVE: 409,
  // Quest engine (Phase 31)
  QUEST_NOT_COMPLETED: 409,
  QUEST_ALREADY_CLAIMED: 409,
  QUEST_EXPIRED: 409,
  QUEST_REWARD_INVALID: 500,
  // World map + territory engine (Phase 32)
  TERRITORY_CAPITAL_PROTECTED: 403,
  TERRITORY_NOT_ADJACENT: 400,
  TERRITORY_LOCKED: 409,
  TERRITORY_OWNED: 400,
  TERRITORY_NOT_COLLECTIBLE: 409,
  REGION_NOT_FOUND: 404,
  // March & army movement engine (Phase 33)
  MARCH_NOT_FOUND: 404,
  MARCH_NOT_CANCELLABLE: 409,
  MARCH_SLOTS_EXHAUSTED: 409,
  MARCH_ORIGIN_NOT_FOUND: 409,
  MARCH_DESTINATION_NOT_OWNED: 400,
  MARCH_INVALID_UNITS: 400,
  // Clans & positional garrisons (Phase 34) — CLAN_ROLE_REQUIRED,
  // ALREADY_IN_CLAN, NOT_IN_CLAN, CLAN_NOT_FOUND, CLAN_HAS_WARS are the
  // reserved Phase 2 codes above.
  CLAN_NAME_TAKEN: 409,
  CLAN_TAG_TAKEN: 409,
  CLAN_FULL: 409,
  CLAN_LEADER_SUCCESSION: 409,
  CLAN_INVITATION_INVALID: 409,
  CLAN_JOIN_POLICY_CLOSED: 403,
  MARCH_GARRISON_FULL: 409,
  MARCH_NOT_WITHDRAWABLE: 409,
  GARRISON_NOT_FOUND: 404,
  GARRISON_UNAUTHORIZED: 403,
  // Security hardening (Phase 23)
  /** Optimistic-CAS credit could not settle within its bounded retry budget. */
  RESOURCE_WALLET_CONFLICT: 409,
  /** XP CAS could not settle within its bounded retry budget. */
  PROGRESSION_CONFLICT: 409,
  /** Cross-site write rejected (Origin/host mismatch on an unsafe method). */
  FORBIDDEN_ORIGIN: 403,
  /** Request body exceeds the size ceiling (checked BEFORE JSON.parse). */
  BODY_TOO_LARGE: 413,
  // Not found (404)
  NOT_FOUND: 404,
  PLAYER_NOT_FOUND: 404,
  USER_NOT_FOUND: 404,
  STAFF_NOT_FOUND: 404,
  EVENT_NOT_FOUND: 404,
  ANNOUNCEMENT_NOT_FOUND: 404,
  TERRITORY_NOT_FOUND: 404,
  BATTLE_NOT_FOUND: 404,
  QUEST_NOT_FOUND: 404,
  BUILDING_NOT_FOUND: 404,
  ORDER_NOT_FOUND: 404,
  CLAN_NOT_FOUND: 404,
  UNIT_NOT_FOUND: 404,
  TRAINING_NOT_FOUND: 404,
  SEASON_NOT_FOUND: 404,
  SEASON_REWARD_NOT_FOUND: 404,
  // Server (500)
  INTERNAL_ERROR: 500,
} as const

export type ErrorCode = keyof typeof ERROR_CODES

/** JSON-safe value constraint for error details (recursion allows issue arrays). */
export type ErrorDetailsValue =
  string | number | boolean | null | ReputationLevel | ErrorDetails | ErrorDetailsValue[]

export interface ErrorDetails {
  [key: string]: ErrorDetailsValue
}

export class AppError extends Error {
  readonly code: ErrorCode
  readonly httpStatus: number
  readonly details?: ErrorDetails

  constructor(code: ErrorCode, message: string, details?: ErrorDetails) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.httpStatus = ERROR_CODES[code]
    this.details = details
  }

  /** structured payload for logging (never leaks secrets) */
  toLog() {
    return { code: this.code, httpStatus: this.httpStatus, details: this.details }
  }
}

// ── Convenience constructors (keep call-sites readable) ─────────────────────

export const errors = {
  unauthorized: (msg = 'Authentication required') => new AppError('UNAUTHORIZED', msg),
  forbidden: (msg = 'Forbidden') => new AppError('FORBIDDEN', msg),
  validation: (msg: string, details?: ErrorDetails) =>
    new AppError('VALIDATION_ERROR', msg, details),
  notFoundPlayer: () => new AppError('PLAYER_NOT_FOUND', 'Player not found'),
  internal: (msg = 'Internal server error') => new AppError('INTERNAL_ERROR', msg),
  insufficient(resource: Lowercase<string>, needed: number, have: number) {
    const code = `INSUFFICIENT_${resource.toUpperCase()}` as ErrorCode
    if (!(code in ERROR_CODES))
      return new AppError('INTERNAL_ERROR', `Unknown resource: ${resource}`)
    return new AppError(code, `Not enough ${resource}: need ${needed}, have ${have}`, {
      needed,
      have,
    })
  },
}
