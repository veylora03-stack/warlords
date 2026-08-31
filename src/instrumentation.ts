/**
 * WARLORDS — Next.js instrumentation hook.
 *
 * Runs once per server process at boot (Node.js runtime only — the edge
 * runtime cannot run Prisma). Hosts the notification queue worker so the
 * Mini App deployment is self-sufficient: the queue drains without any
 * external cron. Under `bun test` the worker disables itself; tests drive
 * `drainNotificationQueue` directly for deterministic timing.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { startNotificationWorker } = await import('@/lib/game/worker/notification-worker')
  startNotificationWorker()
}
