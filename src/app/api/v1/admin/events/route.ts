/**
 * WARLORDS — /api/v1/admin/events (scope: events.view for GET · events.manage for POST — ADMIN only).
 *
 * Event management: list with status filter, spawn a typed event row with a
 * validated window (endsAt > startsAt; PLAYER scope demands a real target).
 * Spawns are audited (EVENT_SPAWN) with the creator recorded on the row.
 */

import { z } from 'zod'
import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { getEnv } from '@/config/env'
import { buildSessionCookie, requireAdminScope, resolveAuthConfig } from '@/lib/auth'
import { createEvent, listEvents, resolvePaging } from '@/lib/game/services/admin'
import { clientIp } from '@/lib/api/request-info'
const EVENT_TYPES = [
  'GOLD_RUSH',
  'BANDIT_ATTACK',
  'PLAGUE',
  'FIRE',
  'MERCHANT_FLEET',
  'RARE_METEOR',
  'NPC_INVASION',
] as const

const listQuery = z.object({
  status: z.enum(['SCHEDULED', 'ACTIVE', 'FINISHED', 'CANCELLED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
})

/**
 * Event config is admin-supplied but persisted verbatim — bounded: keys ≤64
 * chars and the whole serialized blob ≤8 KiB (a deep/oversized record would
 * otherwise bloat rows and downstream renders with no ceiling).
 */
const boundedConfig = z
  .record(z.string().max(64), z.unknown())
  .optional()
  .refine((v) => v === undefined || JSON.stringify(v).length <= 8192, {
    message: 'config must serialize to at most 8192 chars',
  })

const createBody = z.object({
  type: z.enum(EVENT_TYPES),
  title: z.string().min(4).max(120).optional(),
  body: z.string().min(4).max(2000).optional(),
  scope: z.enum(['GLOBAL', 'PLAYER', 'CLAN']).default('GLOBAL'),
  targetPlayerId: z.string().min(1).max(64).optional(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().refine((d) => d.getTime() > Date.now(), {
    message: 'endsAt must be in the future',
  }),
  config: boundedConfig,
})

export const GET = defineRoute({ query: listQuery }, async ({ request, query }) => {
  const env = getEnv()
  const cfg = resolveAuthConfig(env)
  const { refreshed, adminUserId } = await requireAdminScope(request, 'events.view', {
    refresh: true,
    config: cfg,
  })

  const result = await listEvents({
    status: query.status,
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
  const { refreshed, adminUserId } = await requireAdminScope(request, 'events.manage', {
    refresh: true,
    config: cfg,
    rateLimit: 'adminWrite',
  })

  const created = await createEvent({
    actorUserId: adminUserId,
    type: body.type,
    title: body.title,
    body: body.body,
    scope: body.scope,
    targetPlayerId: body.targetPlayerId,
    startsAt: body.startsAt,
    endsAt: body.endsAt,
    config: body.config,
    ip: clientIp(request),
  })

  const headers: Record<string, string> = {}
  if (refreshed) {
    headers['set-cookie'] = buildSessionCookie(refreshed.token, cfg.sessionTtlSeconds, env.isProd)
  }
  return ok(request, created, { headers })
})
