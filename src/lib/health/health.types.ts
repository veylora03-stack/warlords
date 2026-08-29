/**
 * WARLORDS — Health module: domain types.
 *
 * `HealthReport` is the server-side full report. The client-facing projection
 * (same shape minus internals) travels through the standard envelope.
 */

export type DbStatus = 'up' | 'down'

export interface HealthReport {
  status: 'healthy' | 'degraded'
  app: string
  version: string
  phase: number
  db: DbStatus
  dbLatencyMs: number | null
  uptimeSec: number
  timestamp: string
}
