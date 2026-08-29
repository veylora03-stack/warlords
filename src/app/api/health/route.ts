/**
 * WARLORDS — Liveness & readiness probe (HTTP adapter).
 * Thin shell over the health module — business logic lives in the service.
 * Used by the status console, uptime checks, and deployment health gates.
 */

import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { probeHealth } from '@/lib/health'

export const dynamic = 'force-dynamic'

export const GET = defineRoute({}, async ({ request }) => {
  const report = await probeHealth()
  return ok(request, report)
})
