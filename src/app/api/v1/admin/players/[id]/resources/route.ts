/**
 * WARLORDS — POST /api/v1/admin/players/:id/resources (scope: players.adjust_resources — ADMIN only).
 *
 * Resource adjustment through the Phase 5 `adminAdjustResources` path: the
 * ledger is the write surface (reason ADMIN_ADJUSTMENT), no-negative /
 * no-overflow invariants apply, and the AuditLog row with before/after
 * balances commits in the SAME transaction. Signed delta; the client only
 * ever supplies {resource, delta, note} — balances are server-owned.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { adminAdjustResources } from '@/lib/game/services/economy.service'
import { ECONOMY_RESOURCES, MAX_DELTA } from '@/lib/game/config/economy'
import { clientIp } from '@/lib/api/request-info'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })
const adjustBody = z.object({
  resource: z.enum(ECONOMY_RESOURCES),
  /** Signed integer delta — positive credits, negative debits; never zero.
   *  Magnitude is bounded here too (defense-in-depth — the economy service
   *  enforces the same ceiling, but the API contract should not accept what
   *  the invariant layer would refuse). */
  delta: z
    .number()
    .int()
    .refine((v) => v !== 0, { message: 'delta must be non-zero' })
    .refine((v) => Math.abs(v) <= Number(MAX_DELTA), {
      message: `delta exceeds the single-mutation ceiling (±${MAX_DELTA})`,
    }),
  note: z.string().min(4).max(500),
})

export const POST = defineRoute(
  { params: paramsSchema, body: adjustBody },
  async ({ request, params, body }) => {
    const env = getEnv()
    const cfg = resolveAuthConfig(env)
    const { refreshed, adminUserId } = await requireAdminScope(
      request,
      'players.adjust_resources',
      { refresh: true, config: cfg, rateLimit: 'adminWrite' },
    )

    const result = await adminAdjustResources({
      playerId: params.id,
      actorUserId: adminUserId,
      note: `${body.note} (ip ${clientIp(request)})`,
      adjustments: { [body.resource]: BigInt(body.delta) },
    })

    const headers: Record<string, string> = {}
    if (refreshed) {
      headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
    }
    return ok(request, result, { headers })
  },
)
