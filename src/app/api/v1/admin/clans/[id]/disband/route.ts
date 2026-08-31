/**
 * WARLORDS — POST /api/v1/admin/clans/:id/disband (scope: clans.manage — ADMIN only).
 *
 * DESTRUCTIVE, typed-confirmation ("DISBAND"), reason-required, audited
 * with a full pre-deletion snapshot. Refused for clans with war history
 * (CLAN_HAS_WARS) — the war ledger is Restrict-protected history.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { disbandClan } from '@/lib/game/services/admin'
import { ADMIN_CONFIRMATIONS } from '@/lib/game/config/admin'
import { clientIp } from '@/lib/api/request-info'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })
const disbandBody = z.object({
  confirm: z.literal(ADMIN_CONFIRMATIONS.clanDisband, {
    message: `Type "${ADMIN_CONFIRMATIONS.clanDisband}" to confirm`,
  }),
  reason: z.string().min(4).max(300),
})

export const POST = defineRoute(
  { params: paramsSchema, body: disbandBody },
  async ({ request, params, body }) => {
    const env = getEnv()
    const cfg = resolveAuthConfig(env)
    const { refreshed, adminUserId } = await requireAdminScope(request, 'clans.manage', {
      refresh: true,
      config: cfg,
      rateLimit: 'adminWrite',
    })

    const result = await disbandClan({
      clanId: params.id,
      actorUserId: adminUserId,
      confirm: body.confirm,
      reason: body.reason,
      ip: clientIp(request),
    })

    const headers: Record<string, string> = {}
    if (refreshed) {
      headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
    }
    return ok(request, result, { headers })
  },
)
