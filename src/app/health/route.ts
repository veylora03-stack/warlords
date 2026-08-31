/**
 * WARLORDS — GET /health (Phase 26 deployment probe).
 *
 * LIVENESS — "is the process alive?". Deliberately dependency-free (no DB,
 * no auth, no envelope machinery): a wedged database must NOT crash-loop an
 * otherwise healthy process. Load balancers / platforms use this for
 * restart decisions. For "should traffic be routed?" see GET /ready.
 * The rich app-level report (DB latency, version, uptime) remains at
 * GET /api/health for the status console.
 */

import { probeLiveness } from '@/lib/health'

export const dynamic = 'force-dynamic'

export function GET(): Response {
  const body = JSON.stringify(probeLiveness())
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })
}
