/**
 * WARLORDS — /api/v1/admin/announcements (scope: announcements.view for GET ·
 * announcements.create for POST — ADMIN + MODERATOR).
 *
 * Announcement list and creation. Broadcasting/toggling lives on the :id
 * sub-routes (announcements.manage — ADMIN only).
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { createAnnouncement, listAnnouncements, resolvePaging } from '@/lib/game/services/admin'
import { clientIp } from '@/lib/api/request-info'

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
})

const createBody = z.object({
  title: z.string().min(4).max(120),
  body: z.string().min(4).max(2000),
  audience: z.enum(['ALL', 'CLAN', 'PLAYER']).default('ALL'),
  clanId: z.string().min(1).max(64).optional(),
})

export const GET = defineRoute({ query: listQuery }, async ({ request, query }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { refreshed, adminUserId } = await requireAdminScope(request, 'announcements.view', {
    refresh: true,
    config: cfg,
  })

  const result = await listAnnouncements({
    ...resolvePaging(query.page, query.pageSize),
    actorUserId: adminUserId,
  })

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, result, { headers })
})

export const POST = defineRoute({ body: createBody }, async ({ request, body }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { refreshed, adminUserId } = await requireAdminScope(request, 'announcements.create', {
    refresh: true,
    config: cfg,
  })

  const created = await createAnnouncement({
    actorUserId: adminUserId,
    title: body.title,
    body: body.body,
    audience: body.audience,
    clanId: body.clanId,
    ip: clientIp(request),
  })

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, created, { headers })
})
