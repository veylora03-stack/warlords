/**
 * WARLORDS — Health module: domain types.
 *
 * `HealthReport` is the server-side full report. The client-facing projection
 * (same shape minus internals) travels through the standard envelope.
 *
 * Phase 26 adds the deployment-probe contract:
 *  - `ProbeReport`     → GET /health  (liveness — "is the process up?")
 *  - `ReadinessReport` → GET /ready   (readiness — "should traffic be routed?")
 * Liveness must NEVER touch a dependency (a wedged DB must not crash-loop
 * healthy processes); readiness checks real dependencies with a hard timeout.
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

export type ProbeCheckStatus = 'up' | 'down' | 'skipped'

export interface ReadinessCheck {
  status: ProbeCheckStatus
  latencyMs?: number | null
  detail?: string
}

export interface ProbeReport {
  status: 'ok'
  app: string
  version: string
  phase: number
  uptimeSec: number
  timestamp: string
}

export interface ReadinessReport {
  status: 'ready' | 'unavailable'
  app: string
  version: string
  phase: number
  checks: {
    /** Real database round-trip through the same Prisma path game traffic uses. */
    db: ReadinessCheck
    /** Production-critical configuration present (JWT_SECRET, TELEGRAM_BOT_TOKEN). */
    config: ReadinessCheck
    /**
     * Informational — the in-process notification worker registration flag.
     * Non-gating by design: /ready may be polled before instrumentation has
     * registered, and the drain loop is claim-safe across instances anyway.
     */
    worker: ReadinessCheck
  }
  uptimeSec: number
  timestamp: string
}
