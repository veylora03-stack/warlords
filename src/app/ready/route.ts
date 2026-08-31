/**
 * WARLORDS — GET /ready (Phase 26 deployment probe).
 *
 * READINESS — "should traffic be routed to this instance?". Performs a real,
 * hard-timeboxed DB round-trip through the same Prisma path game traffic
 * uses, and (production only) verifies the presence of the config the server
 * refuses to boot without. Returns 503 (not 5xx-with-retry storms) when the
 * instance must be pulled from rotation. Deliberately outside the auth
 * guard and the standard envelope: platform probes parse simple JSON.
 */

import { probeReadiness } from '@/lib/health'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  const report = await probeReadiness()
  return new Response(JSON.stringify(report), {
    status: report.status === 'ready' ? 200 : 503,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })
}
