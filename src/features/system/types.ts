/**
 * WARLORDS — System feature: client-facing health projection.
 * Mirrors the payload returned by GET /api/health (server adds `timestamp`).
 */

export interface HealthData {
  status: 'healthy' | 'degraded'
  app: string
  version: string
  phase: number
  db: 'up' | 'down'
  dbLatencyMs: number | null
  uptimeSec: number
}
