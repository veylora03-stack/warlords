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
    },
    envelope: {
      success: '{ ok: true, data, meta: { requestId, serverTime } }',
      failure: '{ ok: false, error: { code, message, details? }, meta }',
    },
  })
})
