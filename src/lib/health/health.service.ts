/**
 * WARLORDS — Health module: liveness & readiness probe service.
 *
 * Performs a real DB round-trip (SELECT 1) through Prisma — the same path
 * game traffic will use. Never throws: a failing dependency is reported,
 * not crashed on. This module is the reference implementation of the
 * "backend module" pattern:  module folder → service + types + barrel,
 * HTTP adapter (app/api/health/route.ts) stays a thin shell over it.
 */

import { getEnvSafe } from '@/config/env'
import { db } from '@/lib/db'
import { logger } from '@/lib/logger'
import { APP_NAME, APP_PHASE, APP_VERSION } from '@/config/app'
import { isNotificationWorkerActive } from '@/lib/game/worker/notification-worker'
import type {
  DbStatus,
  HealthReport,
  ProbeReport,
  ReadinessCheck,
  ReadinessReport,
} from './health.types'

const log = logger.child({ module: 'health' })

/** Readiness probes must fail fast — a hung DB must not hang the load balancer. */
const DB_PROBE_TIMEOUT_MS = 2_000

/** Production-critical configuration — the env loader refuses prod boots without these. */
const PROD_REQUIRED_CONFIG: ReadonlyArray<{ key: string; env: 'isProd' }> = [
  { key: 'JWT_SECRET', env: 'isProd' },
  { key: 'TELEGRAM_BOT_TOKEN', env: 'isProd' },
]

export async function probeHealth(): Promise<HealthReport> {
  const startedAt = Date.now()
  let dbStatus: DbStatus = 'down'
  let dbLatencyMs: number | null = null

  try {
    await db.$queryRaw`SELECT 1`
    dbStatus = 'up'
    dbLatencyMs = Date.now() - startedAt
  } catch (err) {
    // Deliberately swallowed: health endpoint must report, not throw.
    log.warn('database probe failed', { err, durationMs: Date.now() - startedAt })
  }

  return {
    status: dbStatus === 'up' ? 'healthy' : 'degraded',
    app: APP_NAME.toLowerCase(),
    version: APP_VERSION,
    phase: APP_PHASE,
    db: dbStatus,
    dbLatencyMs,
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  }
}

/**
 * GET /health — liveness probe (Phase 26). Deliberately dependency-free:
 * answers "is the process alive", never "are dependencies healthy". A
 * crashing probe here means restart the process; nothing else.
 */
export function probeLiveness(): ProbeReport {
  return {
    status: 'ok',
    app: APP_NAME.toLowerCase(),
    version: APP_VERSION,
    phase: APP_PHASE,
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  }
}

/**
 * GET /ready — readiness probe (Phase 26). Verifies the dependencies that
 * gate real traffic: a hard-timeboxed DB round-trip through the same Prisma
 * path the game uses, and (production only) the presence of the config the
 * server refuses to boot without. Non-production runs report `config` as
 * `skipped` so sandboxes/CI never flake on missing optional secrets.
 */
export async function probeReadiness(): Promise<ReadinessReport> {
  const env = getEnvSafe()
  const timestamp = new Date().toISOString()
  const uptimeSec = Math.round(process.uptime())

  // ── DB: real round-trip, hard timeout ───────────────────────────────────
  const dbCheck: ReadinessCheck = { status: 'down', latencyMs: null }
  const probeStart = Date.now()
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('db probe timeout')), DB_PROBE_TIMEOUT_MS),
      ),
    ])
    dbCheck.status = 'up'
    dbCheck.latencyMs = Date.now() - probeStart
  } catch (err) {
    dbCheck.status = 'down'
    dbCheck.detail =
      err instanceof Error && err.message === 'db probe timeout'
        ? `no response within ${DB_PROBE_TIMEOUT_MS}ms`
        : 'database probe failed'
    // Deliberately swallowed: readiness must report, not throw.
    log.warn('readiness database probe failed', {
      durationMs: Date.now() - probeStart,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // ── Config: production-critical secrets present ─────────────────────────
  const configCheck: ReadinessCheck = { status: 'skipped', detail: 'non-production run' }
  if (env?.isProd) {
    const missing = PROD_REQUIRED_CONFIG.filter((c) => !env[c.key as keyof typeof env])
    configCheck.status = missing.length === 0 ? 'up' : 'down'
    configCheck.detail =
      missing.length === 0
        ? 'required secrets present'
        : `missing: ${missing.map((m) => m.key).join(', ')}`
  }

  // ── Worker: informational only (never gates readiness) ──────────────────
  const workerCheck: ReadinessCheck = {
    status: isNotificationWorkerActive() ? 'up' : 'skipped',
    detail: isNotificationWorkerActive()
      ? 'in-process notification drain loop registered'
      : 'not registered yet (boot) or non-production run',
  }

  const ready = dbCheck.status === 'up' && configCheck.status !== 'down'
  return {
    status: ready ? 'ready' : 'unavailable',
    app: APP_NAME.toLowerCase(),
    version: APP_VERSION,
    phase: APP_PHASE,
    checks: { db: dbCheck, config: configCheck, worker: workerCheck },
    uptimeSec,
    timestamp,
  }
}
