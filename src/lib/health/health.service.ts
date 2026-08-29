/**
 * WARLORDS — Health module: liveness & readiness probe service.
 *
 * Performs a real DB round-trip (SELECT 1) through Prisma — the same path
 * game traffic will use. Never throws: a failing dependency is reported,
 * not crashed on. This module is the reference implementation of the
 * "backend module" pattern:  module folder → service + types + barrel,
 * HTTP adapter (app/api/health/route.ts) stays a thin shell over it.
 */

import { db } from '@/lib/db'
import { logger } from '@/lib/logger'
import { APP_NAME, APP_PHASE, APP_VERSION } from '@/config/app'
import type { DbStatus, HealthReport } from './health.types'

const log = logger.child({ module: 'health' })

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
