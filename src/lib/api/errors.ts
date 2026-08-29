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
  BANNED: 403,
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
  ALREADY_IN_CLAN: 409,
  NOT_IN_CLAN: 409,
  ORDER_NO_LONGER_OPEN: 409,
  ACTION_ON_COOLDOWN: 429,
  RATE_LIMITED: 429,
  IDEMPOTENT_REPLAY: 409,
  // Not found (404)
  PLAYER_NOT_FOUND: 404,
  TERRITORY_NOT_FOUND: 404,
  BATTLE_NOT_FOUND: 404,
  QUEST_NOT_FOUND: 404,
  ORDER_NOT_FOUND: 404,
  CLAN_NOT_FOUND: 404,
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
