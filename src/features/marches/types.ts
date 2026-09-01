/**
 * WARLORDS — March feature types (mirror of the server DTOs).
 *
 * These mirror src/lib/game/services/march.service.ts read models exactly
 * (MarchView, MarchListView, CancelMarchResult, ProcessMarchResult); nothing
 * here is authoritative — origin, distance, speed, terrain, travel time,
 * arrival, battle outcome, casualties, survivors and capture are all
 * server-computed inside one globally serialized transaction and arrive
 * read-only through the REST envelope. The status/type unions are re-exported
 * (type-only) from the application-layer authority src/lib/game/types/common.
 */

import type { MarchStatus, MarchType } from '@/lib/game/types/common'

export type { MarchStatus, MarchType }

/**
 * The actions a CLIENT may order. RETURN exists in the server union but is a
 * reserved phase of the expedition row, never a client-facing order
 * (engine/march/movement.ts CLIENT_MARCH_TYPES).
 */
export type MarchAction = Exclude<MarchType, 'RETURN'>

/** One immutable manifest line — snapshot taken at creation. */
export interface MarchStackView {
  unitId: string
  unitName: string
  count: number
}

/** Arrival summary written once by the server when the march resolves. */
export interface MarchOutcomeView {
  /** ATTACK: the battle that resolved the assault (absent when aborted). */
  battleId?: string
  result?: 'ATTACKER_WIN' | 'DEFENDER_WIN' | 'DRAW'
  captured?: boolean
  aborted?: string
  scoutReportId?: string
  delivered?: boolean
  unitsLost?: number
  /** Server-written destination coords (used by homecoming notifications). */
  destinationCoord?: { x: number; y: number }
}

export interface MarchView {
  id: string
  type: MarchType
  status: MarchStatus
  origin: { x: number; y: number }
  destination: {
    territoryId: string | null
    x: number | null
    y: number | null
    name: string | null
    terrain: string | null
  }
  units: MarchStackView[]
  survivors: MarchStackView[] | null
  departedAt: string
  arrivesAt: string
  returnsAt: string | null
  completedAt: string | null
  /** Server clock snapshot — the ONLY time a client countdown may trust. */
  serverNowMs: number
  /** Server verdicts — the client never decides state. */
  cancellable: boolean
  dueNow: boolean
  battleId: string | null
  outcome: MarchOutcomeView | null
}

export interface MarchListView {
  marches: MarchView[]
  activeCount: number
  slots: number
}

/** POST /api/v1/marches body — everything else is server-derived. */
export interface CreateMarchInput {
  territoryId: string
  type: MarchAction
  units: Array<{ unitId: string; count: number }>
  /** Client-generated key — a repeated submission replays the first march. */
  idempotencyKey?: string
}

export interface CancelMarchResult {
  march: MarchView
  unitsReleased: number
  /** Mobilization energy is NEVER refunded (config policy — documented). */
  energyRefunded: number
}

export interface ProcessMarchResult {
  march: MarchView
  /** True when this call actually transitioned the march (arrival or return). */
  processed: boolean
}
