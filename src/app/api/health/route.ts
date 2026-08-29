/**
 * WARLORDS — Liveness & readiness probe.
 * Used by the status console, uptime checks, and deployment health gates.
 * A real DB round-trip is performed — no fake status.
 */

import { db } from '@/lib/db'
import { handle, ok } from '@/lib/api/response'

export const dynamic = 'force-dynamic'

const APP_VERSION = '0.1.0-phase0'

export async function GET(request: Request) {
  return handle(request, async () => {
    const startedAt = Date.now()
    let dbStatus: 'up' | 'down' = 'down'
    let dbLatencyMs: number | null = null

    try {
      await db.$queryRaw`SELECT 1`
      dbStatus = 'up'
      dbLatencyMs = Date.now() - startedAt
    } catch {
      // Deliberately swallowed: health endpoint must report, not throw.
      dbStatus = 'down'
    }

    const data = {
      status: dbStatus === 'up' ? 'healthy' : 'degraded',
      app: 'warlords',
      version: APP_VERSION,
      phase: 0,
      db: dbStatus,
      dbLatencyMs,
      uptimeSec: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    }

    return ok(request, data)
  })
}
