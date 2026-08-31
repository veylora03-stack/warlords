/**
 * WARLORDS — Notification worker runtime (Phase 22).
 *
 * The queueable notification pipeline needs a driver. Rather than a second
 * deployable that would duplicate the Prisma client, the worker lives
 * IN-PROCESS: `startNotificationWorker` (called once from
 * `src/instrumentation.ts` at server boot) runs a fixed-interval drain loop
 * against the shared DB. Claiming is an atomic conditional UPDATE per row
 * (count===1), so N app instances can run this loop concurrently without
 * double delivery — horizontal scaling needs no coordination.
 *
 * The loop is also exercisable on demand: POST
 * /api/v1/admin/notifications/worker/tick (ADMIN scope) drains synchronously
 * for operators and tests, which keeps timing deterministic in CI.
 */

import { randomUUID } from 'node:crypto'
import { getEnvSafe } from '@/config/env'
import { logger } from '@/lib/logger'
import { NOTIFICATION_POLICY } from '@/lib/game/config/notifications'
import { drainNotificationQueue } from '@/lib/game/services/notification.service'

const log = logger.child({ module: 'worker/notifications' })

/** Boot delay before the first tick — lets migrations/connections settle. */
const BOOT_DELAY_MS = 5_000

const globalRef = globalThis as typeof globalThis & {
  __warlordsNotificationWorkerStarted?: boolean
}

/**
 * Starts the background drain loop exactly once per process. No-op under
 * `bun test` (NODE_ENV=test) so suites drive the queue deterministically.
 */
export function startNotificationWorker(): void {
  if (globalRef.__warlordsNotificationWorkerStarted) return
  const env = getEnvSafe()
  if (env?.isTest) return
  globalRef.__warlordsNotificationWorkerStarted = true

  const workerId = `worker:${process.pid}:${randomUUID().slice(0, 8)}`

  const tick = async (): Promise<void> => {
    try {
      const result = await drainNotificationQueue({ workerId })
      if (result.claimed > 0) {
        log.info('notification queue drained', { ...result, workerId })
      }
    } catch (cause) {
      // The loop must survive anything (DB restarts, driver hiccups) —
      // the next tick retries; claimed rows are crash-safe by design.
      log.error('notification worker tick failed', {
        workerId,
        error: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  const bootTimer = setTimeout(tick, BOOT_DELAY_MS)
  bootTimer.unref?.()
  const interval = setInterval(tick, NOTIFICATION_POLICY.workerTickMs)
  interval.unref?.()

  log.info('notification worker started', {
    workerId,
    tickMs: NOTIFICATION_POLICY.workerTickMs,
    batchSize: NOTIFICATION_POLICY.workerBatchSize,
  })
}
