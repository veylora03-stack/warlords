/**
 * WARLORDS — API index. Lists the live endpoint surface so clients and
 * operators can discover what exists without reading source code.
 */

import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { APP_NAME, APP_VERSION } from '@/config/app'

export const GET = defineRoute({}, async ({ request }) => {
  return ok(request, {
    service: APP_NAME.toLowerCase(),
    version: APP_VERSION,
    endpoints: {
      health: '/api/health',
      'auth:telegram-login': 'POST /api/v1/auth/telegram',
      'auth:me': 'GET /api/v1/auth/me',
      'auth:logout': 'POST /api/v1/auth/logout',
      'auth:dev-impersonate': 'POST /api/v1/auth/dev-impersonate (non-production only)',
      'player:profile': 'GET /api/v1/player/profile',
      'player:statistics': 'GET /api/v1/player/statistics',
      'player:state': 'GET /api/v1/player/state',
      'player:resources': 'GET /api/v1/player/resources',
      'player:transactions': 'GET /api/v1/player/transactions?limit&cursor&reason (ledger history)',
      'city:state': 'GET /api/v1/city (buildings · production · storage · construction queue)',
      'city:building-catalog':
        'GET /api/v1/city/buildings (per-level costs · durations · requirements · effects)',
      'city:upgrade':
        'POST /api/v1/city/buildings/:type/upgrade (server-side cost + construction timer)',
      'city:finish': 'POST /api/v1/city/buildings/:type/finish (claim completed construction)',
    },
    envelope: {
      success: '{ ok: true, data, meta: { requestId, serverTime } }',
      failure: '{ ok: false, error: { code, message, details? }, meta }',
    },
  })
})
